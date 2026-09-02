//! Bootstraps the plamenix plugin host on app start.
//!
//! Walks `<resource_dir>/plugins/` for every direct subdirectory and
//! tries to load + activate each as a Plamenix plugin bundle. Captures
//! per-plugin contributions and runtime logs into [`PluginsState`] so
//! the React shell can render them.
//!
//! This is the v0 demo — plugins discovered are activated unconditionally,
//! capability prompts and per-plugin permission grants land in a later
//! revision.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use plamenix_meta::MetaStore;
use plamenix_plugin_host::{
    ActivationOutcome, EpochTicker, EventBus, ExtensionPoint, HostState, InstanceRegistry,
    Interception, InterceptorRegistration, InterceptorRegistry, LogLevel, Permission, PluginError,
    PluginHost, RecordedLog, SidebarPanel, SupervisedDelivery, Supervisor, activate_into_registry,
    dispatch_event_supervised, load, run_chain,
};
use semver::Version;
use serde::Serialize;

/// Top-level shape returned by the Tauri command `plugin_list_active`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivePlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub sidebar_panels: Vec<SidebarPanelInfo>,
    pub logs: Vec<PluginLogEntry>,
    pub activation: ActivationInfo,
    /// Permissions the plugin's manifest declares as required.
    pub required_permissions: Vec<String>,
    /// Permissions the plugin's manifest declares as optional.
    pub optional_permissions: Vec<String>,
    /// Subset currently granted by the user (persisted across launches).
    pub granted_permissions: Vec<String>,
    /// Required permissions still awaiting a user grant. Until this is
    /// empty, enforcement layers will refuse to honour calls that touch
    /// those resources (enforcement lands in a follow-up).
    pub pending_permissions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarPanelInfo {
    pub id: String,
    pub label: String,
    pub icon: Option<String>,
}

impl From<&SidebarPanel> for SidebarPanelInfo {
    fn from(p: &SidebarPanel) -> Self {
        Self {
            id: p.id.clone(),
            label: p.label.clone(),
            icon: p.icon.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLogEntry {
    pub level: String,
    pub message: String,
}

impl From<&RecordedLog> for PluginLogEntry {
    fn from(r: &RecordedLog) -> Self {
        Self {
            level: log_level_str(r.level).to_string(),
            message: r.message.clone(),
        }
    }
}

fn log_level_str(level: LogLevel) -> &'static str {
    match level {
        LogLevel::Trace => "trace",
        LogLevel::Debug => "debug",
        LogLevel::Info => "info",
        LogLevel::Warn => "warn",
        LogLevel::Error => "error",
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ActivationInfo {
    Ok,
    Failed { message: String },
}

pub struct PluginsState {
    plugins: Mutex<Vec<ActivePlugin>>,
    grants: Arc<GrantStore>,
    /// Live wasmtime instances, keyed by plugin id.
    ///
    /// Activation used to drop its `Store` the moment `activate()`
    /// returned, so the plugin's linear memory went with it and there
    /// was nowhere to dispatch a later call. Holding the instances here
    /// — for the process lifetime, in Tauri's managed state — is what
    /// makes events, commands and supervision possible at all.
    instances: Arc<InstanceRegistry>,
    /// Keeps wasmtime's epoch advancing for the process lifetime.
    ///
    /// Every plugin store is created with an epoch deadline, but a
    /// deadline is measured against a clock that something has to
    /// advance. Without this the deadlines were inert and a plugin that
    /// looped ran until the process died. Held here so it lives as long
    /// as the instances it polices — dropping it stops the ticking.
    ticker: Mutex<Option<EpochTicker>>,
    /// Topic subscriptions declared by plugin manifests.
    bus: Arc<EventBus>,
    /// Crash budget and restart policy per plugin.
    supervisor: Arc<Supervisor>,
    /// Which plugins asked to be consulted before an operation commits.
    interceptors: Arc<InterceptorRegistry>,
    /// Per-plugin session slots.
    ///
    /// A plugin's `db` imports act on the session the host called it
    /// for, and the store hides its own state once instantiated, so the
    /// shell keeps an `Arc` to the same slot and writes through it
    /// before dispatching. Desktop is single-tenant, but the plugin
    /// still needs to be told *which tab* it is acting for.
    sessions: Mutex<HashMap<String, plamenix_plugin_host::SessionSlot>>,
}

impl PluginsState {
    pub fn new(grants: Arc<GrantStore>) -> Self {
        Self {
            plugins: Mutex::new(Vec::new()),
            grants,
            instances: Arc::new(InstanceRegistry::new()),
            ticker: Mutex::new(None),
            bus: Arc::new(EventBus::new()),
            supervisor: Arc::new(Supervisor::new()),
            interceptors: Arc::new(InterceptorRegistry::new()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Emits `topic` to every subscribed plugin, reporting failures to
    /// the supervisor.
    ///
    /// The single entry point for host-originated events. Returns one
    /// entry per subscriber so the caller can see who was reached and
    /// what the supervisor made of any failure.
    pub async fn emit_event(&self, topic: &str, payload: &str) -> Vec<SupervisedDelivery> {
        dispatch_event_supervised(&self.bus, &self.instances, &self.supervisor, topic, payload)
            .await
    }

    /// Subscriptions and supervision state, for the boot path to
    /// populate as it activates each plugin.
    pub fn bus(&self) -> Arc<EventBus> {
        Arc::clone(&self.bus)
    }

    pub fn supervisor(&self) -> Arc<Supervisor> {
        Arc::clone(&self.supervisor)
    }

    pub fn interceptors(&self) -> Arc<InterceptorRegistry> {
        Arc::clone(&self.interceptors)
    }

    /// Points every activated plugin at the session the user is working
    /// in.
    ///
    /// Called before dispatching anything that a plugin might answer
    /// with a database call. Without it `db.current-session` is always
    /// `None` and every `db` import refuses, which is what the desktop
    /// edition did until now — it never wired a session slot at all.
    pub fn set_session(&self, session_id: Option<&str>) {
        let Ok(slots) = self.sessions.lock() else {
            return;
        };
        for slot in slots.values() {
            if let Ok(mut current) = slot.lock() {
                *current = session_id.map(ToOwned::to_owned);
            }
        }
    }

    /// Runs every plugin registered for `point` and returns the chain's
    /// verdict.
    ///
    /// The shell's TypeScript chain owns ordering against its own
    /// built-in handlers and the 500ms budget; this is the plugin
    /// segment of that chain, run in one call so the UI does not pay a
    /// round trip per plugin.
    pub async fn run_interceptors(
        &self,
        point: ExtensionPoint,
        context_json: &str,
    ) -> (plamenix_plugin_host::Verdict, Vec<Interception>) {
        let registrations = self.interceptors.for_point(point).unwrap_or_default();
        run_chain(&self.instances, &registrations, point, context_json).await
    }

    /// Starts the epoch ticker, if one is not already running.
    ///
    /// Called once from the boot task, which runs inside Tauri's Tokio
    /// runtime — `EpochTicker::spawn` requires one.
    pub fn start_epoch_ticker(&self, host: &PluginHost) {
        if let Ok(mut guard) = self.ticker.lock()
            && guard.is_none()
        {
            *guard = Some(EpochTicker::spawn(host.engine().clone()));
            tracing::info!("epoch ticker started; plugin CPU deadlines are live");
        }
    }

    /// The live instance registry. Shared so the boot path can register
    /// into the same map the commands later read.
    pub fn instances(&self) -> Arc<InstanceRegistry> {
        Arc::clone(&self.instances)
    }

    pub fn snapshot(&self) -> Vec<ActivePlugin> {
        self.plugins
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn replace(&self, next: Vec<ActivePlugin>) {
        if let Ok(mut guard) = self.plugins.lock() {
            *guard = next;
        }
    }

    pub fn grants(&self) -> &GrantStore {
        &self.grants
    }

    /// Records a user grant, but only for a capability the plugin's
    /// manifest actually declared.
    ///
    /// The grant store validates the capability grammar, which stops
    /// arbitrary strings but not a well-formed capability the plugin
    /// never asked for. Without this check a grant could be recorded
    /// for, say, `fs.write.dir.plugin-data` on a plugin whose manifest
    /// requests nothing of the kind — and once runtime gates consult
    /// the grant store, the plugin would hold a capability no install
    /// dialog ever showed the user.
    ///
    /// # Errors
    ///
    /// Returns an error when the plugin is unknown, or when the
    /// capability is outside its declared required and optional sets.
    pub async fn grant_declared(&self, plugin_id: &str, permission: &str) -> Result<(), String> {
        let declared = self
            .snapshot()
            .into_iter()
            .find(|p| p.id == plugin_id)
            .ok_or_else(|| format!("unknown plugin: {plugin_id}"))?;

        let is_declared = declared
            .required_permissions
            .iter()
            .chain(declared.optional_permissions.iter())
            .any(|p| p == permission);

        if !is_declared {
            return Err(format!(
                "plugin `{plugin_id}` does not declare `{permission}`; \
                 a capability can only be granted when its manifest asks for it",
            ));
        }

        self.grants.grant(plugin_id, permission).await
    }

    /// Recomputes the granted/pending lists on every active plugin
    /// after a grant change. Called by the grant/revoke commands.
    pub fn rebuild_permission_view(&self) {
        let grants_map = self.grants.snapshot();
        if let Ok(mut guard) = self.plugins.lock() {
            for p in guard.iter_mut() {
                let granted = grants_map.get(&p.id).cloned().unwrap_or_default();
                p.granted_permissions = granted.iter().cloned().collect();
                p.granted_permissions.sort();
                p.pending_permissions = p
                    .required_permissions
                    .iter()
                    .filter(|r| !granted.contains(*r))
                    .cloned()
                    .collect();
            }
        }
    }
}

/// Plugin capability grants, in Plamenix's own metadata database.
///
/// This was a JSON file beside `profiles.json` while the web edition
/// kept the same grants in a database — two implementations of one
/// thing. Both editions now write to [`plamenix_meta::MetaStore`].
///
/// The in-memory map is a read cache, not the authority. It exists
/// because [`plamenix_plugin_host::HostServices::granted_for`] is
/// synchronous and runs once per plugin call, and a database round trip
/// on that path would tax every event dispatch. The web edition keeps
/// the same shape for the same reason: napi holds the runtime set,
/// the database is what it replays from.
///
/// Writes go to the database first and update the cache only on
/// success, so a failed write leaves the cache honest rather than
/// promising a capability that did not persist.
pub struct GrantStore {
    meta: Arc<MetaStore>,
    cache: Mutex<HashMap<String, HashSet<String>>>,
}

impl GrantStore {
    /// Reads every grant into the cache.
    ///
    /// # Errors
    ///
    /// A human-readable message when the metadata database cannot be
    /// read. Starting with an empty cache instead would silently
    /// un-grant every capability the user has ever approved, and the
    /// plugins would look merely unlucky rather than broken.
    pub async fn open(meta: Arc<MetaStore>) -> Result<Self, String> {
        let all = meta.all_grants().await.map_err(|err| err.to_string())?;
        let cache = all
            .into_iter()
            .map(|(plugin, perms)| (plugin, perms.into_iter().collect()))
            .collect();
        Ok(Self {
            meta,
            cache: Mutex::new(cache),
        })
    }

    pub fn snapshot(&self) -> HashMap<String, HashSet<String>> {
        self.cache.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn granted_for(&self, plugin_id: &str) -> HashSet<String> {
        self.cache
            .lock()
            .ok()
            .and_then(|g| g.get(plugin_id).cloned())
            .unwrap_or_default()
    }

    /// Records a grant.
    ///
    /// # Errors
    ///
    /// When the capability is outside the grammar, or the write fails.
    pub async fn grant(&self, plugin_id: &str, permission: &str) -> Result<(), String> {
        // Validate against the grammar — refuse arbitrary strings.
        let _ = Permission::parse(permission).map_err(|e| e.to_string())?;
        self.meta
            .grant(plugin_id, permission)
            .await
            .map_err(|err| err.to_string())?;
        let mut guard = self.cache.lock().map_err(|e| e.to_string())?;
        guard
            .entry(plugin_id.to_string())
            .or_default()
            .insert(permission.to_string());
        Ok(())
    }

    /// Withdraws a grant. Revoking one never granted is a no-op.
    ///
    /// # Errors
    ///
    /// When the write fails.
    pub async fn revoke(&self, plugin_id: &str, permission: &str) -> Result<(), String> {
        self.meta
            .revoke(plugin_id, permission)
            .await
            .map_err(|err| err.to_string())?;
        let mut guard = self.cache.lock().map_err(|e| e.to_string())?;
        if let Some(set) = guard.get_mut(plugin_id) {
            set.remove(permission);
            if set.is_empty() {
                guard.remove(plugin_id);
            }
        }
        Ok(())
    }
}

/// Loads every plugin bundle under `plugins_root` and returns the
/// active-plugin snapshot to surface to the UI.
pub async fn bootstrap(
    host: &PluginHost,
    host_version: &Version,
    plugins_root: &Path,
    grants: &GrantStore,
    instances: &InstanceRegistry,
    bus: &EventBus,
    supervisor: &Supervisor,
    interceptors: &InterceptorRegistry,
    services: &Arc<dyn plamenix_plugin_host::HostServices>,
    plugin_data_root: &Path,
    sessions: &Mutex<HashMap<String, plamenix_plugin_host::SessionSlot>>,
) -> Vec<ActivePlugin> {
    let mut out = Vec::new();

    let entries = match std::fs::read_dir(plugins_root) {
        Ok(e) => e,
        Err(err) => {
            tracing::warn!(
                ?err,
                ?plugins_root,
                "plugins root unreadable, skipping discovery"
            );
            return out;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        match load_and_activate(
            host,
            host_version,
            &path,
            grants,
            instances,
            bus,
            supervisor,
            interceptors,
            services,
            plugin_data_root,
            sessions,
        )
        .await
        {
            Ok(active) => out.push(active),
            Err(err) => {
                tracing::warn!(?err, ?path, "plugin failed to load");
            }
        }
    }
    out
}

async fn load_and_activate(
    host: &PluginHost,
    host_version: &Version,
    bundle: &Path,
    grants: &GrantStore,
    instances: &InstanceRegistry,
    bus: &EventBus,
    supervisor: &Supervisor,
    interceptors: &InterceptorRegistry,
    services: &Arc<dyn plamenix_plugin_host::HostServices>,
    plugin_data_root: &Path,
    sessions: &Mutex<HashMap<String, plamenix_plugin_host::SessionSlot>>,
) -> Result<ActivePlugin, PluginError> {
    let staged = load(host, host_version, bundle)?;
    let manifest = staged.manifest.clone();

    let log_sink: Arc<Mutex<Vec<RecordedLog>>> = Arc::new(Mutex::new(Vec::new()));

    // The plugin's own corner of the filesystem. Created up front so
    // `fs` and `settings` have somewhere to resolve against; a plugin
    // that never writes anything simply leaves it empty.
    let data_dir = plugin_data_root.join(&manifest.plugin.id);
    if let Err(err) = std::fs::create_dir_all(&data_dir) {
        tracing::warn!(
            plugin = %manifest.plugin.id,
            ?err,
            "could not create the plugin's data directory; its fs and settings imports will fail",
        );
    }

    // Shared with the shell so the session a plugin acts on can be
    // updated from outside the store, which hides its own state once
    // instantiated.
    let session_slot: plamenix_plugin_host::SessionSlot = Arc::new(Mutex::new(None));
    if let Ok(mut slots) = sessions.lock() {
        slots.insert(manifest.plugin.id.clone(), Arc::clone(&session_slot));
    }

    let state = HostState::new(&manifest.plugin.id, host_version.to_string())
        .with_log_sink(log_sink.clone())
        .with_edition("desktop")
        .with_services(Arc::clone(services))
        .with_world(manifest.plugin.world_tier)
        .with_declared_permissions(manifest.permissions.clone())
        .with_session_slot(Arc::clone(&session_slot))
        .with_data_dir(&data_dir);

    // Registers the live store rather than dropping it when `activate`
    // returns. A failed activation is not registered — the activator
    // drops that store itself — so the registry only ever holds
    // instances that are actually usable.
    supervisor.register(&manifest.plugin.id, manifest.plugin.restart_policy)?;

    let outcome = activate_into_registry(host, state, &staged, instances).await?;

    // Subscriptions and supervision come from the manifest, so they are
    // recorded only once the plugin is actually running: a plugin that
    // failed to activate must not sit in the bus collecting events it
    // has no instance to receive.
    if matches!(outcome, ActivationOutcome::Ok) {
        supervisor.mark_active(&manifest.plugin.id, std::time::Instant::now())?;
        for pattern in &manifest.contributions.event_subscriptions {
            if let Err(err) = bus.subscribe(&manifest.plugin.id, pattern) {
                tracing::warn!(
                    plugin = %manifest.plugin.id,
                    pattern,
                    %err,
                    "ignoring an event subscription the bus rejected",
                );
            }
        }
        // Interceptors are the control surface, so a plugin that failed
        // to activate must never end up in a chain: it would be
        // consulted about operations it cannot answer for.
        for entry in &manifest.contributions.interceptors {
            if let Err(err) = interceptors.register(InterceptorRegistration {
                plugin_id: manifest.plugin.id.clone(),
                point: entry.point,
                priority: entry.priority,
                purpose: entry.purpose.clone(),
            }) {
                tracing::warn!(
                    plugin = %manifest.plugin.id,
                    point = entry.point.as_str(),
                    %err,
                    "ignoring an interceptor the registry rejected",
                );
            }
        }
    }

    let logs: Vec<PluginLogEntry> = log_sink
        .lock()
        .map(|guard| guard.iter().map(PluginLogEntry::from).collect())
        .unwrap_or_default();

    let sidebar_panels = manifest
        .contributions
        .sidebar_panels
        .iter()
        .map(SidebarPanelInfo::from)
        .collect();

    let required_permissions: Vec<String> = manifest
        .permissions
        .required_caps()
        .map(|p| p.to_string())
        .collect();
    let optional_permissions: Vec<String> = manifest
        .permissions
        .optional_caps()
        .map(|p| p.to_string())
        .collect();
    let granted_set = grants.granted_for(&manifest.plugin.id);
    let mut granted_permissions: Vec<String> = granted_set.iter().cloned().collect();
    granted_permissions.sort();
    let pending_permissions: Vec<String> = required_permissions
        .iter()
        .filter(|r| !granted_set.contains(*r))
        .cloned()
        .collect();

    Ok(ActivePlugin {
        id: manifest.plugin.id,
        name: manifest.plugin.name,
        version: manifest.plugin.version.to_string(),
        description: manifest.plugin.description,
        sidebar_panels,
        logs,
        activation: match outcome {
            ActivationOutcome::Ok => ActivationInfo::Ok,
            ActivationOutcome::Failed(msg) => ActivationInfo::Failed { message: msg },
        },
        required_permissions,
        optional_permissions,
        granted_permissions,
        pending_permissions,
    })
}

/// Resolves the directory holding bundled plugin folders. In production
/// builds it sits under the Tauri-resolved resource dir; for `tauri dev`
/// it falls back to the repo-local `resources/plugins/` path.
pub fn resolve_plugins_root(resource_dir: &Path) -> PathBuf {
    let bundled = resource_dir.join("plugins");
    if bundled.exists() {
        return bundled;
    }
    #[cfg(debug_assertions)]
    {
        // Dev only: walk up to `plamenix-desktop/resources/plugins`,
        // because `cargo tauri dev` runs from `target/debug` where the
        // bundled directory does not exist.
        //
        // Compiled out of release builds deliberately. An installed app
        // resolves its resource dir inside its own bundle, so a walk up
        // from there passes through directories the user does not
        // control the contents of — on macOS that is
        // `/Applications` and `/` — and the first `resources/plugins`
        // it found would be loaded and activated as trusted code. A
        // release build with no bundled plugins directory should have
        // no plugins, not somebody else's.
        if let Some(found) = resource_dir.ancestors().find_map(|dir| {
            let p = dir.join("resources").join("plugins");
            if p.exists() { Some(p) } else { None }
        }) {
            return found;
        }
    }
    bundled
}

#[cfg(test)]
mod grant_scope_tests {
    use super::*;
    use tempfile::tempdir;

    fn plugin(id: &str, required: &[&str], optional: &[&str]) -> ActivePlugin {
        ActivePlugin {
            id: id.to_string(),
            name: id.to_string(),
            version: "1.0.0".into(),
            description: None,
            sidebar_panels: Vec::new(),
            logs: Vec::new(),
            activation: ActivationInfo::Ok,
            required_permissions: required.iter().map(|s| (*s).to_string()).collect(),
            optional_permissions: optional.iter().map(|s| (*s).to_string()).collect(),
            granted_permissions: Vec::new(),
            pending_permissions: Vec::new(),
        }
    }

    /// The full Firebird install the app ships.
    ///
    /// Grants live in a real database now, so these need the engine.
    /// Skipped rather than faked: a fake store would prove the state
    /// machine calls a function and not that a grant persists.
    fn bundled_fbclient() -> Option<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../resources/fbclient/v50/Resources/lib/libfbclient.dylib");
        path.exists().then(|| path.to_string_lossy().into_owned())
    }

    async fn state_with(plugins: Vec<ActivePlugin>) -> Option<(PluginsState, tempfile::TempDir)> {
        let dir = tempdir().expect("tempdir");
        let meta = Arc::new(
            MetaStore::open(dir.path().join("meta.fdb"), Some(bundled_fbclient()?))
                .await
                .expect("open metadata database"),
        );
        let store = Arc::new(GrantStore::open(meta).await.expect("load grants"));
        let state = PluginsState::new(store);
        state.replace(plugins);
        Some((state, dir))
    }

    #[tokio::test]
    async fn a_declared_capability_can_be_granted() {
        let Some((state, _dir)) =
            state_with(vec![plugin("a.b", &["db.read.any"], &["net.https"])]).await
        else {
            println!("SKIPPED: bundled fbclient not found");
            return;
        };
        state
            .grant_declared("a.b", "db.read.any")
            .await
            .expect("required");
        state
            .grant_declared("a.b", "net.https")
            .await
            .expect("optional");
        assert_eq!(state.grants().granted_for("a.b").len(), 2);
    }

    #[tokio::test]
    async fn an_undeclared_capability_is_refused() {
        // The grammar accepts this string, so only the manifest check
        // stands between a well-formed capability and a grant the
        // install dialog never showed the user.
        let Some((state, _dir)) = state_with(vec![plugin("a.b", &["db.read.any"], &[])]).await
        else {
            println!("SKIPPED: bundled fbclient not found");
            return;
        };
        let err = state
            .grant_declared("a.b", "db.write.any")
            .await
            .expect_err("undeclared capability must be refused");
        assert!(err.contains("does not declare"), "unhelpful error: {err}");
        assert!(state.grants().granted_for("a.b").is_empty());
    }

    #[tokio::test]
    async fn an_unknown_plugin_is_refused() {
        let Some((state, _dir)) = state_with(Vec::new()).await else {
            println!("SKIPPED: bundled fbclient not found");
            return;
        };
        let err = state
            .grant_declared("ghost", "db.read.any")
            .await
            .expect_err("unknown plugin must be refused");
        assert!(err.contains("unknown plugin"), "unhelpful error: {err}");
    }

    #[tokio::test]
    async fn a_revoked_capability_stops_being_granted() {
        // The read cache is what every plugin call consults, so a
        // revoke that reaches the database and not the cache would
        // leave the plugin holding a capability the user withdrew.
        let Some((state, _dir)) =
            state_with(vec![plugin("a.b", &["db.read.any"], &["net.https"])]).await
        else {
            println!("SKIPPED: bundled fbclient not found");
            return;
        };
        state
            .grant_declared("a.b", "db.read.any")
            .await
            .expect("grant");
        state
            .grants()
            .revoke("a.b", "db.read.any")
            .await
            .expect("revoke");
        assert!(state.grants().granted_for("a.b").is_empty());
    }

    #[tokio::test]
    async fn grants_are_read_back_from_the_database_on_open() {
        // What the boot path depends on: the cache is filled from the
        // database rather than starting empty, or every restart would
        // silently un-grant everything the user ever approved.
        let dir = tempdir().expect("tempdir");
        let Some(fbclient) = bundled_fbclient() else {
            println!("SKIPPED: bundled fbclient not found");
            return;
        };
        let meta = Arc::new(
            MetaStore::open(dir.path().join("meta.fdb"), Some(fbclient))
                .await
                .expect("open metadata database"),
        );

        let first = GrantStore::open(meta.clone()).await.expect("first open");
        first.grant("a.b", "db.read.any").await.expect("grant");

        let reopened = GrantStore::open(meta).await.expect("second open");
        assert_eq!(
            reopened.granted_for("a.b"),
            std::collections::HashSet::from(["db.read.any".to_string()]),
        );
    }

    #[tokio::test]
    async fn an_ungrammatical_capability_never_reaches_the_database() {
        let dir = tempdir().expect("tempdir");
        let Some(fbclient) = bundled_fbclient() else {
            println!("SKIPPED: bundled fbclient not found");
            return;
        };
        let meta = Arc::new(
            MetaStore::open(dir.path().join("meta.fdb"), Some(fbclient))
                .await
                .expect("open metadata database"),
        );
        let store = GrantStore::open(meta).await.expect("open");

        store
            .grant("a.b", "not a capability")
            .await
            .expect_err("grammar must be checked before the write");
        assert!(store.granted_for("a.b").is_empty());
    }
}

#[cfg(test)]
mod bundled_manifest_tests {
    //! The manifests we actually ship have to parse.
    //!
    //! Every other test in this repo stages a manifest it wrote itself,
    //! so none of them can catch a mistake in `resources/plugins/`. That
    //! gap is not hypothetical: the bundled `hello` plugin spent its
    //! whole life declaring `db.schema.list`, `os.notify`, and
    //! `clipboard.read` under a world that exposes none of them, asking
    //! users to approve three permissions its code never touched, and
    //! nothing failed.

    use std::path::{Path, PathBuf};

    use plamenix_plugin_host::Manifest;

    fn resources() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent")
            .join("resources/plugins")
    }

    fn bundled() -> Vec<(String, Manifest)> {
        std::fs::read_dir(resources())
            .expect("resources/plugins is readable")
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let text = std::fs::read_to_string(entry.path().join("manifest.toml"))
                    .unwrap_or_else(|err| panic!("{name}: no manifest.toml ({err})"));
                let manifest = Manifest::parse(&text)
                    .unwrap_or_else(|err| panic!("{name}: manifest does not parse: {err}"));
                (name, manifest)
            })
            .collect()
    }

    #[test]
    fn every_bundled_manifest_parses() {
        // Parsing is where the world check, the capability grammar, and
        // the capability-versus-world cross-check all run, so this one
        // assertion covers more than it looks like.
        let all = bundled();
        assert!(!all.is_empty(), "no bundled plugins found");
    }

    #[test]
    fn every_bundled_wasm_file_is_where_its_manifest_says() {
        // A manifest naming a file that is not in the bundle fails at
        // load with the plugin simply missing from the panel, which is
        // a confusing way to find out about a typo.
        for (name, manifest) in bundled() {
            if let Some(wasm) = manifest.entry_points.wasm.as_ref() {
                let path = resources().join(&name).join(wasm);
                assert!(
                    path.exists(),
                    "{name}: {} is missing from the bundle",
                    wasm.display(),
                );
            }
        }
    }

    #[test]
    fn at_least_one_bundled_plugin_exercises_a_capability() {
        // Otherwise the permissions panel has nothing to show and the
        // whole capability model is invisible to anyone running the app
        // — which was true until `table-count` shipped.
        let any_declares = bundled()
            .iter()
            .any(|(_, manifest)| !manifest.permissions.required.is_empty());
        assert!(
            any_declares,
            "no bundled plugin declares a capability; the permissions panel would be empty",
        );
    }
}

#[cfg(test)]
mod plugins_root_tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::resolve_plugins_root;

    #[test]
    fn prefers_the_bundled_directory() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = dir.path().join("plugins");
        std::fs::create_dir_all(&bundled).unwrap();

        assert_eq!(resolve_plugins_root(dir.path()), bundled);
    }

    #[test]
    fn a_release_build_never_loads_plugins_from_outside_its_bundle() {
        // An installed app resolves its resource dir inside its own
        // bundle. Walking up from there passes through directories the
        // user does not control — `/Applications`, `/` — and anything
        // found is loaded and activated as trusted code.
        //
        // The walk is dev-only, so in a release build this must resolve
        // to the bundled path even when a plausible-looking
        // `resources/plugins` sits directly above it.
        let dir = tempfile::tempdir().unwrap();
        let planted = dir.path().join("resources").join("plugins");
        std::fs::create_dir_all(&planted).unwrap();
        let resource_dir = dir.path().join("Contents").join("Resources");
        std::fs::create_dir_all(&resource_dir).unwrap();

        let resolved = resolve_plugins_root(&resource_dir);

        if cfg!(debug_assertions) {
            // Dev builds want exactly this: `cargo tauri dev` runs from
            // `target/debug`, where the bundled directory is absent.
            assert_eq!(resolved, planted);
        } else {
            assert_eq!(
                resolved,
                resource_dir.join("plugins"),
                "a release build resolved plugins outside its own bundle",
            );
            assert!(!resolved.exists(), "and the fallback should not exist");
        }
    }
}
