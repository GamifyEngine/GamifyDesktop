import type { BrowserWindow } from 'electron'

/**
 * Windows in-app game embedding: keeps the Godot game window — launched with
 * `--wid <our HWND>`, which makes the engine create it borderless,
 * windowed-mode-locked and OWNED by our window — glued over the stage rect.
 * Ports the Godot editor's in-editor game view glue (embed_process and
 * friends, platform/windows/display_server_windows.cpp, Godot 4.7): find the
 * owned window by process id, SetWindowPos it over the stage, show/hide it
 * with the stage, WM_CLOSE to close, and a focus dance on detach. Owned
 * windows always float above their owner, so no cross-process SetParent (and
 * its attached-input-queue hazards) is needed; the OS routes input to the
 * game window directly.
 *
 * Implemented with koffi (runtime FFI) rather than a compiled N-API addon
 * because the Windows installer is cross-built from macOS: an MSVC-compiled
 * .node can only be produced on Windows, so a native winhost addon could
 * never make it into the package and embedding silently degraded to a
 * free-floating window. The Win32 surface needed here is tiny and cold
 * (a handful of calls per resize/move), so FFI overhead is irrelevant.
 * koffi's prebuilt win32 binary is staged by fetch-vendor.mjs and shipped
 * into resources/koffi/, one of koffi's built-in Electron search paths.
 *
 * Everything here must stay best-effort safe on a live user desktop: every
 * call re-validates the window handle (the game can die at any moment, and
 * HWNDs are recycled by the OS).
 */

export interface WinHost {
  /** One find-by-pid attempt; false = game window doesn't exist yet, retry. */
  attach(hostHandle: Buffer, pid: number, x: number, y: number, w: number, h: number, visible: boolean): boolean
  /** Screen physical pixels. */
  setFrame(x: number, y: number, w: number, h: number): void
  setVisible(visible: boolean): void
  /** Post WM_CLOSE — the clean close request (what the Godot editor sends). */
  requestClose(): void
  detach(): void
  /** Top-left of the virtual desktop — the origin of Godot's --position space. */
  virtualScreenOrigin(): { x: number; y: number }
}

// Win32 constants (winuser.h) — koffi binds functions, not defines.
const GW_OWNER = 4
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_FRAMECHANGED = 0x0020
const SWP_ASYNCWINDOWPOS = 0x4000
const SW_HIDE = 0
const SW_SHOWNA = 8
const WM_CLOSE = 0x0010
const WS_POPUP = 0x80000000
const WS_VISIBLE = 0x10000000
const WS_EX_TOPMOST = 0x00000008
const HWND_BOTTOM = 1
const HWND_TOPMOST = -1
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77

/**
 * A native window handle as the signed integer Win32 traffics in. Electron's
 * getNativeWindowHandle() buffer holds the raw pointer; read it *signed* so a
 * sign-extended HWND (top bit of the 32-bit handle set) round-trips as the
 * same value Win32 APIs return — HWNDs only carry 32 significant bits, so the
 * magnitude always fits a JS number exactly.
 */
export function nativeHandleInt(handle: Buffer): number {
  return Number(handle.length >= 8 ? handle.readBigInt64LE(0) : BigInt(handle.readInt32LE(0)))
}

/** The Electron window's HWND as the integer string Godot's --wid expects. */
export function windowHandleArg(win: BrowserWindow): string {
  return String(nativeHandleInt(win.getNativeWindowHandle()))
}

function createWinHost(): WinHost {
  // Lazy so non-Windows platforms never load the FFI runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof import('koffi')
  const user32 = koffi.load('user32.dll')

  // Handles travel as plain `intptr` integers instead of koffi's opaque
  // pointer objects so HWNDs can be compared and stored naturally.
  const FindWindowExW = user32.func(
    'intptr __stdcall FindWindowExW(intptr parent, intptr childAfter, const char16_t *cls, const char16_t *title)'
  )
  const GetWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32_t *pid)'
  )
  const GetWindow = user32.func('intptr __stdcall GetWindow(intptr hwnd, uint32_t cmd)')
  const IsWindow = user32.func('int __stdcall IsWindow(intptr hwnd)')
  const SetWindowPos = user32.func(
    'int __stdcall SetWindowPos(intptr hwnd, intptr insertAfter, int x, int y, int w, int h, uint32_t flags)'
  )
  const ShowWindow = user32.func('int __stdcall ShowWindow(intptr hwnd, int cmd)')
  const SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(intptr hwnd)')
  const SetFocus = user32.func('intptr __stdcall SetFocus(intptr hwnd)')
  const PostMessageW = user32.func('int __stdcall PostMessageW(intptr hwnd, uint32_t msg, uintptr wparam, intptr lparam)')
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)')
  const CreateWindowExW = user32.func(
    'intptr __stdcall CreateWindowExW(uint32_t exStyle, const char16_t *cls, const char16_t *title, uint32_t style, int x, int y, int w, int h, intptr owner, intptr menu, intptr instance, intptr param)'
  )
  const DestroyWindow = user32.func('int __stdcall DestroyWindow(intptr hwnd)')

  let gameHwnd = 0
  let hostHwnd = 0

  // The game window handle is only usable while it identifies a live window;
  // drop it the moment it goes stale (the OS recycles HWND values).
  const gameWindowAlive = (): boolean => {
    if (gameHwnd && !IsWindow(gameHwnd)) gameHwnd = 0
    return gameHwnd !== 0
  }

  // Same SetWindowPos flags as DisplayServerWindows::embed_process: keep the
  // current z-order (owned windows already float above the owner), never
  // steal activation, and don't block on the game's thread.
  const positionGameWindow = (x: number, y: number, w: number, h: number): void => {
    SetWindowPos(gameHwnd, HWND_BOTTOM, x, y, Math.max(1, w), Math.max(1, h), SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)
  }

  // Mirrors _enum_proc_find_window_from_process_id_callback (Godot), walking
  // top-level windows with FindWindowExW instead of an EnumWindows callback:
  // the game's main window is the one whose process id matches AND whose
  // owner is our host window (the engine set that owner itself because of
  // --wid).
  const findGameWindow = (pid: number, host: number): number => {
    const pidOut = [0]
    let hwnd = 0
    while ((hwnd = Number(FindWindowExW(0, hwnd, null, null))) !== 0) {
      GetWindowThreadProcessId(hwnd, pidOut)
      if (pidOut[0] === pid && Number(GetWindow(hwnd, GW_OWNER)) === host) return hwnd
    }
    return 0
  }

  return {
    attach(hostHandle, pid, x, y, w, h, visible) {
      const host = nativeHandleInt(hostHandle)
      const found = findGameWindow(pid, host)
      if (!found) return false

      gameHwnd = found
      hostHwnd = host

      positionGameWindow(x, y, w, h)
      // SW_SHOWNA like Godot, so showing the game never yanks activation
      // away from whatever the user is typing into.
      ShowWindow(gameHwnd, visible ? SW_SHOWNA : SW_HIDE)
      if (visible) {
        // Mirrors the p_grab_focus branch of embed_process. Allowed because
        // our process is foreground when the user clicks Run — the OS lets
        // the foreground process hand foreground status to another window.
        SetForegroundWindow(gameHwnd)
        SetFocus(gameHwnd)
      }
      return true
    },

    setFrame(x, y, w, h) {
      if (gameWindowAlive()) positionGameWindow(x, y, w, h)
    },

    setVisible(visible) {
      if (gameWindowAlive()) ShowWindow(gameHwnd, visible ? SW_SHOWNA : SW_HIDE)
    },

    requestClose() {
      if (gameWindowAlive()) PostMessageW(gameHwnd, WM_CLOSE, 0, 0)
    },

    // The temp-window dance is Godot's documented workaround (see
    // remove_embedded_process): when the embedded window is closed while it
    // has focus, the host window looks focused but is not truly activated;
    // opening and closing a topmost popup forces Windows to recompute
    // activation. The predefined STATIC class stands in for the throwaway
    // DefWindowProc class Godot registers — FFI can't cheaply supply a
    // WNDPROC pointer, and the window only exists for a microsecond.
    detach() {
      if (hostHwnd) {
        const tmp = Number(CreateWindowExW(WS_EX_TOPMOST, 'STATIC', '', WS_POPUP | WS_VISIBLE, 0, 0, 1, 1, hostHwnd, 0, 0, 0))
        if (tmp) {
          SetWindowPos(tmp, HWND_TOPMOST, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE)
          DestroyWindow(tmp)
        }
        SetForegroundWindow(hostHwnd)
      }
      gameHwnd = 0
      hostHwnd = 0
    },

    // Godot's --position argument is in Godot screen space, whose origin is
    // the top-left-most corner of the virtual desktop (_get_screens_origin in
    // display_server_windows.cpp) — Win32 screen coordinates minus this.
    virtualScreenOrigin() {
      return { x: Number(GetSystemMetrics(SM_XVIRTUALSCREEN)), y: Number(GetSystemMetrics(SM_YVIRTUALSCREEN)) }
    }
  }
}

let cached: WinHost | null | undefined

/**
 * The embedding glue, or null where unavailable (non-Windows, or koffi failed
 * to load — e.g. its prebuilt binary missing from the package). Callers fall
 * back to free-floating windowed play on null.
 */
export function winhost(): WinHost | null {
  if (cached === undefined) {
    if (process.platform !== 'win32') {
      cached = null
    } else {
      try {
        cached = createWinHost()
      } catch (err) {
        console.error('[gamifydesktop] winhost unavailable:', err)
        cached = null
      }
    }
  }
  return cached
}
