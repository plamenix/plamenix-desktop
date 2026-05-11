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
    resolve_connection_config, resolve_pure_rust,
};
use plamenix_secrets::{SecretRef, SecretStore};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResponse {
    pub session_id: SessionId,
}

#[tauri::command]
pub fn profile_list(state: State<'_, ProfilesState>) -> Result<Vec<Profile>, String> {
    state.store.list().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn profile_save(
    state: State<'_, ProfilesState>,
    draft: ProfileDraft,
) -> Result<Profile, String> {
    let id = draft.id.unwrap_or_default();
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
    };

    if let Ok(existing) = state.store.get(id) {
        profile.password_keyring_ref = existing.password_keyring_ref;
        profile.encryption_key_keyring_ref = existing.encryption_key_keyring_ref;
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
pub async fn profile_connect(
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
    };

    let config = resolve_connection_config(
        &profile,
        &profiles.secrets,
        &profiles.service,
        &runtime,
        &overrides,
    )
    .map_err(|err| err.to_string())?;

    let mode = if resolve_pure_rust(&profile, &overrides) {
        ConnectMode::PureRust
    } else {
        ConnectMode::Native
    };

    db.driver()
        .connect(config, mode)
        .await
        .map(|session_id| ConnectResponse { session_id })
        .map_err(|err| err.to_string())
}
