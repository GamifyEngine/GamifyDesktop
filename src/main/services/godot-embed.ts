import { createServer, type Server, type Socket } from 'node:net'
import { frameMessage, GdVector2i, MessageReader, type DebuggerMessage } from './godot-wire'

/**
 * Debug-protocol session with an embedded Godot game (macOS, Godot 4.6+).
 *
 * GamifyDesktop acts as the "editor" side of Godot's remote debugger: the game is
 * launched with `--embedded --remote-debug tcp://127.0.0.1:<port>` which makes
 * it render into a cross-process CAContext instead of opening a window. Over
 * this channel the game reports its CAContext id (displayed in-window via the
 * layerhost native addon) and receives display state, window size and input
 * events — mirroring platform/macos/editor/embedded_process_macos.mm.
 */

// Thread::MAIN_ID on the Godot side.
const MAIN_THREAD_ID = 1n

// DisplayServer::WindowEvent (servers/display/display_server_enums.h)
export const WIN_EVENT = {
  MOUSE_ENTER: 0,
  MOUSE_EXIT: 1,
  FOCUS_IN: 2,
  FOCUS_OUT: 3,
  CLOSE_REQUEST: 4
} as const

// MainLoop notifications (core/os/main_loop.h)
export const NOTIFICATION = {
  APPLICATION_FOCUS_IN: 2016,
  APPLICATION_FOCUS_OUT: 2017
} as const

export interface DsState {
  /** Backing scale of the display (2.0 on Retina). */
  scale: number
  dpi: number
  /** CGDirectDisplayID of the display showing the game (Electron display.id). */
  displayId: number
}

export interface EmbedSessionCallbacks {
  /** The game shared its CAContext — time to attach the layer host. */
  onContextId(contextId: number): void
  /** The game wants a different cursor over its view. */
  onCursorShape(shape: number): void
  onDisconnect(): void
  /** Reply from the injected test agent: `ogtest:done` → [id, ok, text]. */
  onTestReply?(id: number, ok: boolean, text: string): void
  /** ~1/s frame-timing batch from the injected agent: `ogperf:frames` → deltas in seconds. */
  onPerfFrames?(deltas: number[]): void
}

export class EmbedSession {
  private server: Server | null = null
  private socket: Socket | null = null
  private reader = new MessageReader()
  private closed = false

  constructor(private callbacks: EmbedSessionCallbacks) {}

  /** Start the debugger server; resolves with the port to pass to the game. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        if (this.socket) {
          // Single game session per server; refuse extra connections.
          socket.destroy()
          return
        }
        this.socket = socket
        socket.on('data', (chunk: Buffer) => {
          for (const message of this.reader.push(chunk)) this.handleMessage(message)
        })
        socket.on('close', () => {
          this.socket = null
          if (!this.closed) this.callbacks.onDisconnect()
        })
        socket.on('error', () => {})
        this.onConnected?.()
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
  }

  /** Set before the game connects; fired once the debug channel is up. */
  onConnected: (() => void) | null = null

  private handleMessage(message: DebuggerMessage): void {
    switch (message.name) {
      case 'game_view:set_context_id':
        // CAContextID is uint32; the wire encodes it as a signed int32, so
        // high-bit ids arrive negative — normalize before use.
        this.callbacks.onContextId(Number(message.data[0] ?? 0) >>> 0)
        break
      case 'game_view:cursor_set_shape':
        this.callbacks.onCursorShape(Number(message.data[0] ?? 0))
        break
      case 'ogtest:done':
        this.callbacks.onTestReply?.(
          Number(message.data[0] ?? -1),
          Boolean(message.data[1]),
          String(message.data[2] ?? '')
        )
        break
      case 'ogperf:frames': {
        const deltas = message.data[0]
        if (Array.isArray(deltas)) {
          this.callbacks.onPerfFrames?.(deltas.filter((d): d is number => typeof d === 'number'))
        }
        break
      }
      case 'debug_enter':
        // A breakpoint/error pause would freeze the game with no debugger UI
        // attached — resume immediately.
        this.send('continue', [], message.threadId)
        break
      default:
        // Ignore the rest of the debugger traffic (output/errors arrive via
        // the process's stdio, performance profiling is unused, etc).
        break
    }
  }

  private send(name: string, data: Parameters<typeof frameMessage>[2], threadId: bigint | number = MAIN_THREAD_ID): void {
    this.socket?.write(frameMessage(name, threadId, data))
  }

  /** Serialized DisplayServerMacOSEmbeddedState (32 bytes). */
  sendDsState(state: DsState): void {
    const buf = Buffer.alloc(32)
    buf.writeFloatLE(state.scale, 0) // screen_max_scale
    buf.writeFloatLE(state.dpi, 4) // screen_dpi
    buf.writeFloatLE(state.scale, 8) // screen_window_scale
    buf.writeUInt32LE(state.displayId >>> 0, 12)
    buf.writeDoubleLE(1.0, 16) // screen_max_edr
    buf.writeDoubleLE(1.0, 24) // screen_max_potential_edr
    this.send('embed:ds_state', [new Uint8Array(buf)])
  }

  /** Game viewport size in points. */
  sendWindowSize(width: number, height: number): void {
    this.send('embed:window_size', [new GdVector2i(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))])
  }

  /** Encoded InputEvent (see godot-input-codec.ts). */
  sendInputEvent(encoded: Uint8Array): void {
    this.send('embed:event', [encoded])
  }

  sendWinEvent(event: number): void {
    this.send('embed:win_event', [event])
  }

  sendNotification(notification: number): void {
    this.send('embed:notification', [notification])
  }

  requestClose(): void {
    this.sendWinEvent(WIN_EVENT.CLOSE_REQUEST)
  }

  /** Command for the injected test agent (see test-agent.ts). */
  sendTestCommand(command: string, id: number, args: (string | number)[]): void {
    this.send(`ogtest:${command}`, [id, ...args])
  }

  close(): void {
    this.closed = true
    this.socket?.destroy()
    this.socket = null
    this.server?.close()
    this.server = null
  }
}
