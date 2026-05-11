// Tauri's recommended pattern: the platform-specific entry point delegates to
// the library crate so the same `run()` works on desktop and mobile.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    plamenix_desktop_lib::run();
}
