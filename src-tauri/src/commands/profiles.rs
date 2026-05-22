//! Tauri commands for saved connection profiles.
//!
//! Profiles are JSON-on-disk (managed by `plamenix-profiles`); the
//! password and encryption-key are stored separately in the OS keyring
//! (managed by `plamenix-secrets`). The profile JSON only ever carries
//! the keyring *reference*, never the plaintext.

// `tauri::State<'_, T>` is required by-value by `#[tauri::command]`,
// so clippy's `needless_pass_by_value` doesn't fit here.
#![allow(clippy::needless_pass_by_value)]

use plamenix_db::{ConnectMode, DbDriver, SessionId};
use plamenix_profiles::{
    ConnectOverrides, Profile, ProfileId, ProfileStore, RuntimeSecrets,
    now_epoch_ms, resolve_connection_config, resolve_pure_rust,
};
use plamenix_secrets::{SecretRef, SecretStore};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::db::DbState;
use crate::fbclient::bundled_path;
use crate::profiles::ProfilesState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDraft {
    pub id: Option<ProfileId>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    #[serde(default)]
    pub encryption_required: bool,
    #[serde(default)]
    pub pure_rust: bool,
    /// Plaintext password to write into the keyring under
    /// `profile:<id>:password`. Omit to leave the existing entry in
    /// place; pass an empty string to clear the stored credential.
    pub password: Option<String>,
    /// Same shape as `password`, stored under
    /// `profile:<id>:encryption-key`.
    pub encryption_key: Option<String>,
    /// Optional accent-palette id used by the UI to tint this profile's
    /// tabs and status dot.
    #[serde(default)]
    pub color: Option<String>,
    /// Optional absolute path to the Firebird native client library
    /// (`libfbclient.dylib` / `.so` / `fbclient.dll`). Empty string is
    /// treated as `None`. Ignored when `pure_rust` is `true`.
    #[serde(default)]
    pub fbclient_path: Option<String>,
    /// Wire charset for the session. Empty string is treated as `None`,
    /// which falls back to `UTF8`.
    #[serde(default)]
    pub charset: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileConnectRequest {
    pub profile_id: ProfileId,
    pub password: Option<String>,
    pub encryption_key: Option<String>,
    pub pure_rust: Option<bool>,
    pub encryption_required: Option<bool>,
    pub fbclient_path: Option<String>,
    pub charset: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResponse {
    pub session_id: SessionId,
}

#[tauri::command]
#[tracing::instrument(name = "cmd.profile_list", skip(state))]
pub fn profile_list(state: State<'_, ProfilesState>) -> Result<Vec<Profile>, String> {
    state.store.list().map_err(|err| err.to_string())
}

#[tauri::command]
#[tracing::instrument(
    name = "cmd.profile_save",
    skip(state, draft),
    fields(name = %draft.name, profile = ?draft.id),
)]
pub fn profile_save(
    state: State<'_, ProfilesState>,
    draft: ProfileDraft,
) -> Result<Profile, String> {
    let id = draft.id.unwrap_or_default();
    let now = now_epoch_ms();
    let mut profile = Profile {
        id,
        name: draft.name,
        host: draft.host,
        port: draft.port,
        database: draft.database,
        user: draft.user,
        password_keyring_ref: None,
        encryption_key_keyring_ref: None,
        encryption_required: draft.encryption_required,
        pure_rust: draft.pure_rust,
        color: draft.color,
        created_at: now,
        last_used_at: None,
        last_disconnected_at: None,
        fbclient_path: draft.fbclient_path.filter(|s| !s.is_empty()),
        charset: draft.charset.filter(|s| !s.is_empty()),
    };

    if let Ok(existing) = state.store.get(id) {
        profile.password_keyring_ref = existing.password_keyring_ref;
        profile.encryption_key_keyring_ref = existing.encryption_key_keyring_ref;
        // Preserve the original creation timestamp on edits; only the
        // very first save fixes `created_at`.
        if existing.created_at != 0 {
            profile.created_at = existing.created_at;
        }
        profile.last_used_at = existing.last_used_at;
        profile.last_disconnected_at = existing.last_disconnected_at;
    }

    if let Some(value) = draft.password {
        let account = format!("profile:{}:password", id.0);
        let secret_ref = SecretRef::new(&state.service, &account);
        if value.is_empty() {
            state.secrets.delete(&secret_ref).map_err(|err| err.to_string())?;
            profile.password_keyring_ref = None;
        } else {
            state.secrets.store(&secret_ref, &value).map_err(|err| err.to_string())?;
            profile.password_keyring_ref = Some(account);
        }
    }
    if let Some(value) = draft.encryption_key {
        let account = format!("profile:{}:encryption-key", id.0);
        let secret_ref = SecretRef::new(&state.service, &account);
        if value.is_empty() {
            state.secrets.delete(&secret_ref).map_err(|err| err.to_string())?;
            profile.encryption_key_keyring_ref = None;
        } else {
            state.secrets.store(&secret_ref, &value).map_err(|err| err.to_string())?;
            profile.encryption_key_keyring_ref = Some(account);
        }
    }

    state.store.save(profile).map_err(|err| err.to_string())
}

#[tauri::command]
#[tracing::instrument(name = "cmd.profile_delete", skip(state), fields(profile = %id.0))]
pub fn profile_delete(
    state: State<'_, ProfilesState>,
    id: ProfileId,
) -> Result<(), String> {
    if let Ok(existing) = state.store.get(id) {
        if let Some(account) = existing.password_keyring_ref {
            let _ = state.secrets.delete(&SecretRef::new(&state.service, account));
        }
        if let Some(account) = existing.encryption_key_keyring_ref {
            let _ = state.secrets.delete(&SecretRef::new(&state.service, account));
        }
    }
    state.store.delete(id).map_err(|err| err.to_string())
}

#[tauri::command]
#[tracing::instrument(
    name = "cmd.profile_connect",
    skip(profiles, db, request),
    fields(profile = %request.profile_id.0),
)]
pub async fn profile_connect(
    app: AppHandle,
    profiles: State<'_, ProfilesState>,
    db: State<'_, DbState>,
    request: ProfileConnectRequest,
) -> Result<ConnectResponse, String> {
    let profile = profiles
        .store
        .get(request.profile_id)
        .map_err(|err| err.to_string())?;

    let runtime = RuntimeSecrets {
        password: request.password,
        encryption_key: request.encryption_key,
    };
    let overrides = ConnectOverrides {
        pure_rust: request.pure_rust,
        encryption_required: request.encryption_required,
        fbclient_path: request.fbclient_path,
        charset: request.charset,
    };

    let mut config = resolve_connection_config(
        &profile,
        &profiles.secrets,
        &profiles.service,
        &runtime,
        &overrides,
    )
    .map_err(|err| err.to_string())?;

    let pure_rust = resolve_pure_rust(&profile, &overrides);
    let mode = if pure_rust { ConnectMode::PureRust } else { ConnectMode::Native };
    if !pure_rust
        && config.fbclient_path.is_none()
        && let Some(path) = bundled_path(&app)
    {
        config.fbclient_path = Some(path.to_string_lossy().into_owned());
    }

    let outcome = db.driver().connect(config, mode).await;
    if outcome.is_ok() {
        // Best-effort: a touch failure should never break a working
        // connect. Log it and move on.
        if let Err(err) = profiles.store.touch(request.profile_id, now_epoch_ms()) {
            tracing::warn!(?err, "profile touch failed");
        }
    }
    outcome
        .map(|session_id| ConnectResponse { session_id })
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[tracing::instrument(name = "cmd.profile_touch_disconnected", skip(state), fields(profile = %id.0))]
pub fn profile_touch_disconnected(
    state: State<'_, ProfilesState>,
    id: ProfileId,
) -> Result<(), String> {
    state
        .store
        .touch_disconnected(id, now_epoch_ms())
        .map_err(|err| err.to_string())
}
