use plamenix_plugin_host::{ExtensionPoint, InterceptorRegistration, RestartDecision, Verdict};
use serde::Serialize;
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
pub async fn plugin_grant_permission(
    state: State<'_, PluginsState>,
    plugin_id: String,
    permission: String,
) -> Result<Vec<ActivePlugin>, String> {
    state.grant_declared(&plugin_id, &permission).await?;
    state.rebuild_permission_view();
    Ok(state.snapshot())
}

#[tauri::command]
#[tracing::instrument(
    name = "cmd.plugin_revoke_permission",
    skip(state),
    fields(plugin = %plugin_id, permission = %permission),
)]
pub async fn plugin_revoke_permission(
    state: State<'_, PluginsState>,
    plugin_id: String,
    permission: String,
) -> Result<Vec<ActivePlugin>, String> {
    state.grants().revoke(&plugin_id, &permission).await?;
    state.rebuild_permission_view();
    Ok(state.snapshot())
}

/// Which plugins are wired into which interceptor chain, in resolved
/// order.
///
/// The renderer reads this once at boot to decide which chains need a
/// plugin handler at all. A chain nobody registered for must not pay a
/// round trip on every operation.
#[tauri::command]
#[tracing::instrument(name = "cmd.plugin_list_interceptors", skip(state))]
pub fn plugin_list_interceptors(state: State<'_, PluginsState>) -> Vec<InterceptorRegistration> {
    state.interceptors().all().unwrap_or_default()
}

/// What the renderer gets back after consulting the plugin segment of a
/// chain.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterceptorOutcome {
    /// `proceed`, `replace`, or `cancel`.
    pub verdict: Verdict,
    /// Plugins whose call failed and were skipped, with the reason.
    /// Present so a slow or broken plugin can be attributed rather than
    /// silently ignored — fail-open should be visible, not invisible.
    pub skipped: Vec<SkippedInterceptor>,
}

/// One plugin that did not get a say, and why.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedInterceptor {
    pub plugin_id: String,
    pub reason: String,
}

/// Runs the plugin segment of an interceptor chain.
///
/// Never returns an error. An interceptor that fails is skipped and the
/// operation proceeds — see the fail-open rationale in
/// `plamenix_plugin_host::interceptor`. Surfacing a failure as a
/// command error would turn a broken third-party plugin into a blocked
/// query, which is the outcome the whole design avoids.
#[tauri::command]
#[tracing::instrument(
    name = "cmd.plugin_run_interceptors",
    skip(state, context_json),
    fields(point = %extension_point),
)]
pub async fn plugin_run_interceptors(
    state: State<'_, PluginsState>,
    extension_point: String,
    context_json: String,
) -> Result<InterceptorOutcome, String> {
    let point = ExtensionPoint::parse(&extension_point).map_err(|err| err.to_string())?;
    let (verdict, steps) = state.run_interceptors(point, &context_json).await;
    let skipped = steps
        .into_iter()
        .filter_map(|step| {
            step.failure.map(|failure| SkippedInterceptor {
                plugin_id: step.plugin_id,
                reason: format!("{}: {}", failure.kind, failure.message),
            })
        })
        .collect();
    Ok(InterceptorOutcome { verdict, skipped })
}

/// Which event patterns any plugin is currently subscribed to.
///
/// The renderer asks for this so it can forward only the events
/// something actually wants. Most shell events originate in the UI — a
/// tab opening, an editor gaining focus — so reaching a WASM plugin
/// costs a command per event, and `editor/changed` fires as the user
/// types. With nothing subscribed, the renderer sends nothing.
#[tauri::command]
#[tracing::instrument(name = "cmd.plugin_event_patterns", skip(state))]
pub fn plugin_event_patterns(state: State<'_, PluginsState>) -> Vec<String> {
    state.bus().subscribed_patterns()
}

/// Dispatches a shell event to every plugin subscribed to its topic.
///
/// The renderer is the source: these events happen in the UI. Returns
/// one entry per subscriber so a caller can see who was reached, and
/// resolves rather than failing — a plugin trapping on an event must
/// not fail the interaction that produced it.
#[tauri::command]
#[tracing::instrument(name = "cmd.plugin_emit_event", skip(state, payload), fields(topic = %topic))]
pub async fn plugin_emit_event(
    state: State<'_, PluginsState>,
    topic: String,
    payload: String,
    session_id: Option<String>,
) -> Result<Vec<PluginDelivery>, String> {
    // Points subscribers at the session the event is about, so a plugin
    // handling it can use the `db` capability it was granted. The
    // execute path sets this too; an event that did not come from one
    // would otherwise leave whatever the last statement set.
    if let Some(session) = session_id.as_deref() {
        state.set_session(Some(session));
    }
    Ok(state
        .emit_event(&topic, &payload)
        .await
        .into_iter()
        .map(|delivery| PluginDelivery {
            plugin_id: delivery.plugin_id,
            status: format!("{:?}", delivery.outcome),
            // Only `Disable` takes a plugin out of rotation; `Restart`
            // and `Stop` are recoverable and the panel should not
            // present them as the user's problem.
            disabled: matches!(delivery.decision, Some(RestartDecision::Disable { .. })),
        })
        .collect())
}

/// One subscriber's outcome, flattened for the renderer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDelivery {
    pub plugin_id: String,
    pub status: String,
    /// `true` when the supervisor took the plugin out of rotation.
    pub disabled: bool,
}
