//! Tauri-managed wrapper around the profile store and the keyring.
//!
//! Built once in `lib::run`'s `.setup` closure (because the profile
//! path comes from the app's config dir) and handed to commands via
//! `tauri::State`. The keyring service name is the canonical
//! `dev.plamenix.desktop` namespace; every keyring entry the desktop
//! edition writes lives under this service.

use std::path::PathBuf;

use plamenix_profiles::JsonFileStore;
use plamenix_secrets::KeyringStore;

pub const SERVICE: &str = "dev.plamenix.desktop";

pub struct ProfilesState {
    pub store: JsonFileStore,
    pub secrets: KeyringStore,
    pub service: String,
}

impl ProfilesState {
    pub fn new(profiles_path: PathBuf, service: impl Into<String>) -> Self {
        Self {
            store: JsonFileStore::new(profiles_path),
            secrets: KeyringStore::new(),
            service: service.into(),
        }
    }
}
