mod boot;
mod commands;
mod db;
mod fbclient;
mod history;
mod plugins;
mod profiles;

use std::time::Duration;

use boot::{BootStep, bring_to_front, emit_step, finish};
use db::DbState;
use history::{HistoryStore, default_history_path};
use plamenix_plugin_host::PluginHost;
use plugins::{
    GrantStore, PluginsState, bootstrap as plugin_bootstrap, default_grants_path,
    resolve_plugins_root,
};
use profiles::{ProfilesState, SERVICE};
use semver::Version;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(DbState::new())
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::db::db_connect,
            commands::db::db_execute,
            commands::db::db_ping,
            commands::db::db_close,
            commands::db::db_set_transaction_mode,
            commands::db::db_begin_transaction,
            commands::db::db_commit,
            commands::db::db_rollback,
            commands::db::db_transaction_status,
            commands::db::db_crypt_state,
            commands::db::db_describe_schema,
            commands::db::db_database_stats,
            commands::db::db_fetch_blob,
            commands::db::db_test_connection,
            commands::db::db_list_aliases,
            commands::export::db_export,
            commands::db::history_list,
            commands::db::history_clear,
            commands::db::history_set_label,
            commands::db::history_delete,
            commands::db::history_delete_many,
            commands::plugins::plugin_list_active,
            commands::plugins::plugin_grant_permission,
            commands::plugins::plugin_revoke_permission,
            commands::profiles::profile_list,
            commands::profiles::profile_save,
            commands::profiles::profile_delete,
            commands::profiles::profile_connect,
            commands::profiles::profile_touch_disconnected,
            commands::fbclient::fbclient_download,
            commands::fbclient::fbclient_bundled_path,
            commands::fbclient::fbclient_list_releases,
            commands::fbclient::fbclient_inspect_dir,
        ])
        .setup(|app| {
            // Splash window is declared `visible: true` in tauri.conf,
            // but on macOS the OS may render it behind whatever app
            // launched Plamenix. Force it to the front so the user
            // sees the boot progress on top, then again for the main
            // window inside `boot::finish` once initialisation is
            // done.
            if let Some(splash) = app.get_webview_window("splash") {
                bring_to_front(&splash);
            }

            let app_config_dir = app
                .path()
                .app_config_dir()
                .map_err(|err| format!("resolve app_config_dir: {err}"))?;
            let profiles_path = app_config_dir.join("profiles.json");
            app.manage(ProfilesState::new(profiles_path, SERVICE));
            let history_path = default_history_path(&app_config_dir);
            let history_store = HistoryStore::open(&history_path)
                .map_err(|err| format!("open history store: {err}"))?;
            app.manage(history_store);

            let grants_store = Arc::new(GrantStore::open(default_grants_path(&app_config_dir)));
            let plugins_state = PluginsState::new(grants_store.clone());
            app.manage(plugins_state);

            let resource_dir = app
                .path()
                .resource_dir()
                .map_err(|err| format!("resolve resource_dir: {err}"))?;
            let plugins_root = resolve_plugins_root(&resource_dir);

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                emit_step(&handle, &BootStep::new("Initialising core"));
                tokio::time::sleep(Duration::from_millis(800)).await;

                emit_step(&handle, &BootStep::new("Scanning plugins"));
                let host_version =
                    Version::parse(env!("CARGO_PKG_VERSION")).unwrap_or_else(|_| Version::new(1, 0, 0));
                match PluginHost::new() {
                    Ok(host) => {
                        let active =
                            plugin_bootstrap(&host, &host_version, &plugins_root, &grants_store)
                                .await;
                        let count = active.len();
                        match handle.try_state::<PluginsState>() {
                            Some(state) => {
                                state.replace(active);
                                tracing::info!(count, "plugins activated and published to state");
                            }
                            None => {
                                tracing::error!(
                                    count,
                                    "plugins activated but PluginsState not registered — UI will see empty list",
                                );
                            }
                        }
                    }
                    Err(err) => {
                        tracing::error!(?err, "plugin host failed to start");
                    }
                }
                tokio::time::sleep(Duration::from_millis(400)).await;

                emit_step(&handle, &BootStep::new("Loading workspace"));
                tokio::time::sleep(Duration::from_millis(800)).await;

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
