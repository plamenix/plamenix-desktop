use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct BootStep {
    pub label: String,
    pub detail: Option<String>,
}

impl BootStep {
    pub fn new(label: impl Into<String>) -> Self {
        Self { label: label.into(), detail: None }
    }
}

pub fn emit_step(app: &AppHandle, step: &BootStep) {
    if let Err(err) = app.emit("boot:step", step) {
        tracing::warn!(?err, "failed to emit boot:step");
    }
}

pub fn finish(app: &AppHandle) {
    if let Some(splash) = app.get_webview_window("splash")
        && let Err(err) = splash.close()
    {
        tracing::warn!(?err, "failed to close splash window");
    }
    if let Some(main) = app.get_webview_window("main")
        && let Err(err) = main.show()
    {
        tracing::warn!(?err, "failed to show main window");
    }
}
