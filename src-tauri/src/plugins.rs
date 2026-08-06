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

use plamenix_plugin_host::{
    ActivationOutcome, HostState, LogLevel, Permission, PluginError, PluginHost, RecordedLog,
    SidebarPanel, activate_with_state, load,
};
use semver::Version;
use serde::{Deserialize, Serialize};

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
}

impl PluginsState {
    pub fn new(grants: Arc<GrantStore>) -> Self {
        Self {
            plugins: Mutex::new(Vec::new()),
            grants,
        }
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

/// On-disk grant store. JSON file: `{ "<plugin_id>": ["perm1", ...] }`.
/// Lives next to `profiles.json` and `history.sqlite` under the
/// app config directory.
pub struct GrantStore {
    path: PathBuf,
    state: Mutex<HashMap<String, HashSet<String>>>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(transparent)]
struct GrantsFile(HashMap<String, HashSet<String>>);

impl GrantStore {
    pub fn open(path: PathBuf) -> Self {
        let state = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<GrantsFile>(&text).ok())
            .map(|f| f.0)
            .unwrap_or_default();
        Self {
            path,
            state: Mutex::new(state),
        }
    }

    pub fn snapshot(&self) -> HashMap<String, HashSet<String>> {
        self.state.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn granted_for(&self, plugin_id: &str) -> HashSet<String> {
        self.state
            .lock()
            .ok()
            .and_then(|g| g.get(plugin_id).cloned())
            .unwrap_or_default()
    }

    pub fn grant(&self, plugin_id: &str, permission: &str) -> Result<(), String> {
        // Validate against the grammar — refuse arbitrary strings.
        let _ = Permission::parse(permission).map_err(|e| e.to_string())?;
        let mut guard = self.state.lock().map_err(|e| e.to_string())?;
        guard
            .entry(plugin_id.to_string())
            .or_default()
            .insert(permission.to_string());
        self.persist(&guard)
    }

    pub fn revoke(&self, plugin_id: &str, permission: &str) -> Result<(), String> {
        let mut guard = self.state.lock().map_err(|e| e.to_string())?;
        if let Some(set) = guard.get_mut(plugin_id) {
            set.remove(permission);
            if set.is_empty() {
                guard.remove(plugin_id);
            }
        }
        self.persist(&guard)
    }

    fn persist(&self, state: &HashMap<String, HashSet<String>>) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create grants dir: {e}"))?;
        }
        let text = serde_json::to_string_pretty(&GrantsFile(state.clone()))
            .map_err(|e| format!("serialize grants: {e}"))?;
        std::fs::write(&self.path, text).map_err(|e| format!("write grants file: {e}"))
    }
}

pub fn default_grants_path(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join("plugin_grants.json")
}

/// Loads every plugin bundle under `plugins_root` and returns the
/// active-plugin snapshot to surface to the UI.
pub async fn bootstrap(
    host: &PluginHost,
    host_version: &Version,
    plugins_root: &Path,
    grants: &GrantStore,
) -> Vec<ActivePlugin> {
    let mut out = Vec::new();

    let entries = match std::fs::read_dir(plugins_root) {
        Ok(e) => e,
        Err(err) => {
            tracing::warn!(?err, ?plugins_root, "plugins root unreadable, skipping discovery");
            return out;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        match load_and_activate(host, host_version, &path, grants).await {
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
) -> Result<ActivePlugin, PluginError> {
    let staged = load(host, host_version, bundle)?;
    let manifest = staged.manifest.clone();

    let log_sink: Arc<Mutex<Vec<RecordedLog>>> = Arc::new(Mutex::new(Vec::new()));
    let state = HostState::new(&manifest.plugin.id, host_version.to_string())
        .with_log_sink(log_sink.clone());

    let outcome = activate_with_state(host, state, &staged).await?;

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
    // Dev mode: walk up to plamenix-desktop/resources/plugins.
    let candidate = resource_dir
        .ancestors()
        .find_map(|dir| {
            let p = dir.join("resources").join("plugins");
            if p.exists() { Some(p) } else { None }
        })
        .unwrap_or(bundled);
    candidate
}
