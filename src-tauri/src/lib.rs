mod boot;
mod commands;
mod db;
mod fbclient;
mod history;
mod plugin_services;
mod plugins;
mod profiles;

use std::time::Duration;

use boot::{BootStep, bring_to_front, emit_step, finish};
use db::DbState;
use history::{HistoryStore, default_history_path};
use plamenix_plugin_host::PluginHost;
use plugins::{GrantStore, PluginsState, bootstrap as plugin_bootstrap, resolve_plugins_root};
use profiles::{ProfilesState, SERVICE};
use semver::Version;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
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
            commands::plugins::plugin_list_interceptors,
            commands::plugins::plugin_run_interceptors,
            commands::plugins::plugin_event_patterns,
            commands::plugins::plugin_emit_event,
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
            // Blocking here rather than in the async boot task: every
            // command that touches history needs the store present in
            // managed state before the window can call one, and the
            // window opens as soon as setup returns.
            let meta = tauri::async_runtime::block_on(HistoryStore::open(
                &history_path,
                crate::fbclient::bundled_path(&app.handle().clone())
                    .map(|p| p.to_string_lossy().into_owned()),
            ))
            .map_err(|err| format!("open metadata database: {err}"))?;
            app.manage(HistoryStore::new(meta.clone()));

            // Same store, same file. Grants used to be a JSON sidecar
            // here while the web edition kept them in a database; one
            // implementation now, and the read cache is filled before
            // the window can ask a plugin what it may do.
            let grants_store = Arc::new(
                tauri::async_runtime::block_on(GrantStore::open(meta))
                    .map_err(|err| format!("load plugin grants: {err}"))?,
            );
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
                        // The registry lives in PluginsState, so the
                        // instances registered here outlive this boot
                        // task and stay reachable from the commands.
                        let instances = match handle.try_state::<PluginsState>() {
                            Some(state) => state.instances(),
                            None => {
                                tracing::error!(
                                    "PluginsState not registered before plugin bootstrap; \
                                     activating without a live instance registry",
                                );
                                std::sync::Arc::new(
                                    plamenix_plugin_host::InstanceRegistry::new(),
                                )
                            }
                        };
                        // Before activating anything: a store's epoch
                        // deadline only means something once something
                        // is advancing the epoch.
                        if let Some(state) = handle.try_state::<PluginsState>() {
                            state.start_epoch_ticker(&host);
                        }
                        let (bus, supervisor, interceptors) =
                            match handle.try_state::<PluginsState>() {
                                Some(state) => {
                                    (state.bus(), state.supervisor(), state.interceptors())
                                }
                                None => (
                                    std::sync::Arc::new(plamenix_plugin_host::EventBus::new()),
                                    std::sync::Arc::new(plamenix_plugin_host::Supervisor::new()),
                                    std::sync::Arc::new(
                                        plamenix_plugin_host::InterceptorRegistry::new(),
                                    ),
                                ),
                            };
                        // What plugins can actually reach. Until this
                        // existed every host import beyond logging
                        // refused, because the host had no way to the
                        // driver, the keyring, or the window.
                        // The same driver the Tauri commands use. It is
                        // `Arc`-backed, so this clone shares the session
                        // registry rather than starting an empty one —
                        // a second driver would see none of the user's
                        // connections.
                        let driver_for_plugins = handle
                            .try_state::<DbState>()
                            .map(|state| state.driver().clone())
                            .unwrap_or_default();
                        let services: std::sync::Arc<
                            dyn plamenix_plugin_host::HostServices,
                        > = std::sync::Arc::new(
                            crate::plugin_services::DesktopHostServices::new(
                                driver_for_plugins,
                                std::sync::Arc::clone(&grants_store),
                                std::sync::Arc::new(plamenix_secrets::KeyringStore::new()),
                                handle.clone(),
                            ),
                        );
                        let plugin_data_root = app_config_dir.join("plugin-data");
                        let sessions_holder =
                            std::sync::Mutex::new(std::collections::HashMap::new());
                        let active = plugin_bootstrap(
                            &host,
                            &host_version,
                            &plugins_root,
                            &grants_store,
                            &instances,
                            &bus,
                            &supervisor,
                            &interceptors,
                            &services,
                            &plugin_data_root,
                            &sessions_holder,
                        )
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
