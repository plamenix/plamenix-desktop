use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Debug, Clone, Serialize)]
pub struct BootStep {
    pub label: String,
    pub detail: Option<String>,
}

impl BootStep {
    pub fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            detail: None,
        }
    }
}

pub fn emit_step(app: &AppHandle, step: &BootStep) {
    if let Err(err) = app.emit("boot:step", step) {
        tracing::warn!(?err, "failed to emit boot:step");
    }
}

/// Force the supplied window to the top of the z-order and focus it.
///
/// On macOS, Tauri 2.11's `WebviewWindow::set_focus()` is a no-op
/// (upstream tao bug: tauri-apps/tauri#12834), so we drive AppKit
/// directly via `[NSApp activateIgnoringOtherApps:YES]` to pull the
/// Plamenix process out from behind whichever app launched it (Finder,
/// terminal, IDE). Without this the user sees the splash or the main
/// window flash but stay hidden under the focused app.
pub fn bring_to_front(window: &WebviewWindow) {
    if let Err(err) = window.show() {
        tracing::warn!(?err, label = %window.label(), "failed to show window");
    }
    if let Err(err) = window.unminimize() {
        tracing::warn!(?err, label = %window.label(), "failed to unminimize window");
    }
    #[cfg(target_os = "macos")]
    #[allow(unsafe_code)]
    {
        use objc2::{msg_send, runtime::AnyObject};
        // SAFETY: NSApplication.sharedApplication is a stable AppKit
        // singleton accessor that is safe to call once the app has been
        // initialised (true by the time any window exists), and
        // `activateIgnoringOtherApps:` takes a single BOOL and is a
        // no-op when the app is already active.
        unsafe {
            let cls = objc2::runtime::AnyClass::get("NSApplication").unwrap();
            let app_ns: *mut AnyObject = msg_send![cls, sharedApplication];
            let _: () = msg_send![app_ns, activateIgnoringOtherApps: true];
        }
    }
    if let Err(err) = window.set_focus() {
        tracing::warn!(?err, label = %window.label(), "failed to focus window");
    }
}

pub fn finish(app: &AppHandle) {
    if let Some(splash) = app.get_webview_window("splash")
        && let Err(err) = splash.close()
    {
        tracing::warn!(?err, "failed to close splash window");
    }
    if let Some(main) = app.get_webview_window("main") {
        bring_to_front(&main);
    }
    // Tell the main window that all managed state (plugins, history,
    // profiles) is populated and safe to query. React mounts inside the
    // hidden main window long before this point, so useEffect calls
    // that race the bootstrap need to refetch on this event.
    if let Err(err) = app.emit("boot:ready", ()) {
        tracing::warn!(?err, "failed to emit boot:ready");
    }
}
