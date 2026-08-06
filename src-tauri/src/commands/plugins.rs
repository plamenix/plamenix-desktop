use tauri::State;

use crate::plugins::{ActivePlugin, PluginsState};

#[tauri::command]
#[tracing::instrument(name = "cmd.plugin_list_active", skip(state))]
pub fn plugin_list_active(state: State<'_, PluginsState>) -> Vec<ActivePlugin> {
    state.snapshot()
}

#[tauri::command]
#[tracing::instrument(
    name = "cmd.plugin_grant_permission",
    skip(state),
    fields(plugin = %plugin_id, permission = %permission),
)]
pub fn plugin_grant_permission(
    state: State<'_, PluginsState>,
    plugin_id: String,
    permission: String,
) -> Result<Vec<ActivePlugin>, String> {
    state.grant_declared(&plugin_id, &permission)?;
    state.rebuild_permission_view();
    Ok(state.snapshot())
}

#[tauri::command]
#[tracing::instrument(
    name = "cmd.plugin_revoke_permission",
    skip(state),
    fields(plugin = %plugin_id, permission = %permission),
)]
pub fn plugin_revoke_permission(
    state: State<'_, PluginsState>,
    plugin_id: String,
    permission: String,
) -> Result<Vec<ActivePlugin>, String> {
    state.grants().revoke(&plugin_id, &permission)?;
    state.rebuild_permission_view();
    Ok(state.snapshot())
}
