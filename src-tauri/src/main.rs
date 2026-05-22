// Tauri's recommended pattern: the platform-specific entry point delegates to
// the library crate so the same `run()` works on desktop and mobile.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let _tracing_guard = match plamenix_tracing::init() {
        Ok((guard, outcome)) => {
            match &outcome {
                plamenix_tracing::InitOutcome::FmtOnly => {
                    tracing::info!("tracing initialised (fmt only)");
                }
                plamenix_tracing::InitOutcome::OtlpEnabled {
                    endpoint,
                    service_name,
                } => {
                    tracing::info!(%endpoint, %service_name, "tracing initialised with OTLP exporter");
                }
                _ => tracing::info!("tracing initialised"),
            }
            Some(guard)
        }
        Err(err) => {
            eprintln!("failed to initialise tracing: {err}");
            None
        }
    };

    plamenix_desktop_lib::run();
}
