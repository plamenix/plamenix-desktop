mod boot;
mod commands;
mod db;
mod profiles;

use std::time::Duration;

use boot::{BootStep, emit_step, finish};
use db::DbState;
use profiles::{ProfilesState, SERVICE};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .manage(DbState::new())
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::db::db_connect,
            commands::db::db_execute,
            commands::db::db_ping,
            commands::db::db_close,
            commands::db::db_crypt_state,
            commands::profiles::profile_list,
            commands::profiles::profile_save,
            commands::profiles::profile_delete,
            commands::profiles::profile_connect,
        ])
        .setup(|app| {
            let profiles_path = app
                .path()
                .app_config_dir()
                .map_err(|err| format!("resolve app_config_dir: {err}"))?
                .join("profiles.json");
            app.manage(ProfilesState::new(profiles_path, SERVICE));

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
