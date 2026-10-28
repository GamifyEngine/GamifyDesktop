// N-API addon that hosts a remote CoreAnimation context (CAContext, the
// mechanism Godot 4.6+'s embedded display server renders into) inside an
// Electron window. The Godot editor uses the same SPI for its in-editor game
// view on macOS (see platform/macos/editor/embedded_process_macos.mm).
//
// The hosting NSView returns nil from hitTest so all input continues to flow
// to Electron's web contents; GamifyDesktop forwards input to the game over the
// debugger channel.

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

#include <node_api.h>

// QuartzCore SPI (same declarations Godot ships in macos_quartz_core_spi.h).
@interface CALayerHost : CALayer
@property (nonatomic) uint32_t contextId;
@end

@interface OGLayerHostView : NSView
@end

@implementation OGLayerHostView
- (NSView *)hitTest:(NSPoint)point {
  return nil; // Input passes through to the web contents beneath.
}
@end

// The game's remote root layer uses anchorPoint (0,1): its content hangs
// *downward* from the host layer's position in bottom-up CA coordinates.
// Mirror the editor: position the CALayerHost at the view's top-left and let
// the remote tree extend down-right (no frame/bounds on the host layer).
static void PositionHostLayer(OGLayerHostView *view, CALayerHost *host) {
  host.position = CGPointMake(0, view.bounds.size.height);
}

static OGLayerHostView *g_hostView = nil;
static CALayerHost *g_layerHost = nil;

#define NAPI_CALL(env, call)                              \
  do {                                                    \
    if ((call) != napi_ok) {                              \
      napi_throw_error(env, nullptr, "N-API call failed: " #call); \
      return nullptr;                                     \
    }                                                     \
  } while (0)

static double GetNumberArg(napi_env env, napi_value value) {
  double out = 0;
  napi_get_value_double(env, value, &out);
  return out;
}

// attach(nsviewHandle: Buffer, contextId: number, x, y, w, h) -> bool
static napi_value Attach(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
  if (argc < 6) {
    napi_throw_error(env, nullptr, "attach requires (handle, contextId, x, y, w, h)");
    return nullptr;
  }

  void *data = nullptr;
  size_t length = 0;
  NAPI_CALL(env, napi_get_buffer_info(env, args[0], &data, &length));
  if (length < sizeof(void *)) {
    napi_throw_error(env, nullptr, "invalid native window handle buffer");
    return nullptr;
  }
  // Electron's getNativeWindowHandle() yields the content NSView*.
  NSView *contentView = *reinterpret_cast<NSView *__unsafe_unretained *>(data);

  // Double → int64 → uint32: converting an out-of-range/negative double
  // directly to uint32_t is undefined behavior.
  uint32_t contextId = (uint32_t)(int64_t)GetNumberArg(env, args[1]);
  CGFloat x = GetNumberArg(env, args[2]);
  CGFloat y = GetNumberArg(env, args[3]);
  CGFloat w = GetNumberArg(env, args[4]);
  CGFloat h = GetNumberArg(env, args[5]);

  if (g_hostView) {
    [g_hostView removeFromSuperview];
    g_hostView = nil;
    g_layerHost = nil;
  }

  // The content NSView may not be flipped; convert from top-left CSS coords.
  NSRect frame = NSMakeRect(x, contentView.isFlipped ? y : contentView.bounds.size.height - y - h, w, h);

  Class layerHostClass = NSClassFromString(@"CALayerHost");
  if (!layerHostClass) {
    napi_throw_error(env, nullptr, "CALayerHost class unavailable");
    return nullptr;
  }

  OGLayerHostView *view = [[OGLayerHostView alloc] initWithFrame:frame];
  view.wantsLayer = YES;
  view.layer.masksToBounds = YES; // Clip if the game layer briefly outsizes the stage.

  // Mirrors DisplayServerMacOS::embed_process_update (Godot 4.7).
  CALayerHost *host = [layerHostClass new];
  host.contextId = contextId;
  host.contentsScale = contentView.window ? contentView.window.backingScaleFactor : 2.0;
  host.contentsGravity = kCAGravityCenter;
  [view.layer addSublayer:host];
  PositionHostLayer(view, host);

  [contentView addSubview:view]; // On top of the web contents view.
  g_hostView = view;
  g_layerHost = host;

  napi_value result;
  NAPI_CALL(env, napi_get_boolean(env, true, &result));
  return result;
}

// setFrame(x, y, w, h) — CSS top-left coordinates within the content view.
static napi_value SetFrame(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
  if (g_hostView && argc >= 4) {
    CGFloat x = GetNumberArg(env, args[0]);
    CGFloat y = GetNumberArg(env, args[1]);
    CGFloat w = GetNumberArg(env, args[2]);
    CGFloat h = GetNumberArg(env, args[3]);
    NSView *superview = g_hostView.superview;
    if (superview) {
      NSRect frame = NSMakeRect(x, superview.isFlipped ? y : superview.bounds.size.height - y - h, w, h);
      [CATransaction begin];
      [CATransaction setDisableActions:YES];
      g_hostView.frame = frame;
      if (g_layerHost) PositionHostLayer(g_hostView, g_layerHost);
      [CATransaction commit];
    }
  }
  return nullptr;
}

// setScale(scale) — scale the hosted tree (the AI test run's live monitor
// shows the full-size off-screen game shrunk into a small box). The host
// layer has zero-size bounds, so the transform scales about its position —
// the view's top-left — keeping the remote content anchored there.
static napi_value SetScale(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
  if (g_layerHost && argc >= 1) {
    CGFloat s = GetNumberArg(env, args[0]);
    if (s > 0) {
      [CATransaction begin];
      [CATransaction setDisableActions:YES];
      g_layerHost.transform = CATransform3DMakeScale(s, s, 1);
      [CATransaction commit];
    }
  }
  return nullptr;
}

// setVisible(visible: boolean)
static napi_value SetVisible(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  NAPI_CALL(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
  if (g_hostView && argc >= 1) {
    bool visible = false;
    napi_get_value_bool(env, args[0], &visible);
    g_hostView.hidden = !visible;
  }
  return nullptr;
}

static napi_value Detach(napi_env env, napi_callback_info info) {
  if (g_hostView) {
    [g_hostView removeFromSuperview];
    g_hostView = nil;
    g_layerHost = nil;
  }
  return nullptr;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;

  napi_create_function(env, "attach", NAPI_AUTO_LENGTH, Attach, nullptr, &fn);
  napi_set_named_property(env, exports, "attach", fn);
  napi_create_function(env, "setFrame", NAPI_AUTO_LENGTH, SetFrame, nullptr, &fn);
  napi_set_named_property(env, exports, "setFrame", fn);
  napi_create_function(env, "setScale", NAPI_AUTO_LENGTH, SetScale, nullptr, &fn);
  napi_set_named_property(env, exports, "setScale", fn);
  napi_create_function(env, "setVisible", NAPI_AUTO_LENGTH, SetVisible, nullptr, &fn);
  napi_set_named_property(env, exports, "setVisible", fn);
  napi_create_function(env, "detach", NAPI_AUTO_LENGTH, Detach, nullptr, &fn);
  napi_set_named_property(env, exports, "detach", fn);

  return exports;
}

NAPI_MODULE(layerhost, Init)
