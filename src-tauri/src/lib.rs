mod boot;
mod commands;
mod db;

use std::time::Duration;

use boot::{BootStep, emit_step, finish};
use db::DbState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(DbState::new())
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::db::db_connect,
            commands::db::db_execute,
            commands::db::db_ping,
            commands::db::db_close,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                emit_step(&handle, &BootStep::new("Initialising core"));
                tokio::time::sleep(Duration::from_millis(150)).await;

                emit_step(&handle, &BootStep::new("Scanning plugins"));
                tokio::time::sleep(Duration::from_millis(150)).await;

                emit_step(&handle, &BootStep::new("Loading workspace"));
                tokio::time::sleep(Duration::from_millis(150)).await;

                finish(&handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(err) = result {
        tracing::error!(?err, "tauri application terminated abnormally");
        std::process::exit(1);
    }
}
