//! Tauri-managed wrapper around the profile store and the keyring.
//!
//! Built once in `lib::run`'s `.setup` closure (because the profile
//! path comes from the app's config dir) and handed to commands via
//! `tauri::State`. The keyring service name is the canonical
//! `dev.plamenix.desktop` namespace; every keyring entry the desktop
//! edition writes lives under this service.

use std::path::{Path, PathBuf};

use plamenix_profiles::JsonFileStore;
#[cfg(debug_assertions)]
use plamenix_secrets::JsonSecretStore;
use plamenix_secrets::{KeyringStore, SecretError, SecretRef, SecretStore};

pub const SERVICE: &str = "dev.plamenix.desktop";

/// Secret backend selected at compile time. Dev / debug builds use a
/// plain-text JSON file because macOS keychain ACL is bound to the
/// binary hash — every `cargo build` re-prompts "Always Allow". Release
/// builds use the real OS keyring.
///
/// In dev mode, the JSON store transparently migrates from the keyring:
/// on a JSON miss, the keyring is queried (one-time keychain prompt for
/// "Always Allow"), the value is promoted to the JSON file, and
/// subsequent reads stay file-only.
#[cfg(debug_assertions)]
pub enum SecretBackend {
    File {
        json: JsonSecretStore,
        keyring: KeyringStore,
    },
}

#[cfg(not(debug_assertions))]
pub enum SecretBackend {
    Keyring(KeyringStore),
}

impl SecretBackend {
    #[cfg(debug_assertions)]
    pub fn new(config_dir: &Path) -> Result<Self, SecretError> {
        let path = config_dir.join("dev-secrets.json");
        Ok(Self::File {
            json: JsonSecretStore::open(path)?,
            keyring: KeyringStore::new(),
        })
    }

    #[cfg(not(debug_assertions))]
    pub fn new(_config_dir: &Path) -> Result<Self, SecretError> {
        Ok(Self::Keyring(KeyringStore::new()))
    }
}

impl SecretStore for SecretBackend {
    fn store(&self, secret_ref: &SecretRef, secret: &str) -> Result<(), SecretError> {
        match self {
            #[cfg(debug_assertions)]
            Self::File { json, .. } => json.store(secret_ref, secret),
            #[cfg(not(debug_assertions))]
            Self::Keyring(s) => s.store(secret_ref, secret),
        }
    }

    fn retrieve(&self, secret_ref: &SecretRef) -> Result<String, SecretError> {
        match self {
            #[cfg(debug_assertions)]
            Self::File { json, keyring } => match json.retrieve(secret_ref) {
                Ok(value) => Ok(value),
                Err(SecretError::NotFound { .. }) => {
                    // Profile was saved before we switched to the JSON
                    // dev-secrets backend; pull the value out of the OS
                    // keyring once (this is the one and only keychain
                    // prompt) and write it into the JSON file so future
                    // reads stay file-only.
                    let value = keyring.retrieve(secret_ref)?;
                    if let Err(err) = json.store(secret_ref, &value) {
                        tracing::warn!(
                            ?err,
                            "failed to promote keyring secret into dev-secrets.json"
                        );
                    } else {
                        tracing::info!(
                            account = %secret_ref.account,
                            "migrated keyring secret into dev-secrets.json"
                        );
                    }
                    Ok(value)
                }
                Err(other) => Err(other),
            },
            #[cfg(not(debug_assertions))]
            Self::Keyring(s) => s.retrieve(secret_ref),
        }
    }

    fn delete(&self, secret_ref: &SecretRef) -> Result<(), SecretError> {
        match self {
            #[cfg(debug_assertions)]
            Self::File { json, keyring } => {
                json.delete(secret_ref)?;
                // Best-effort: also evict from keyring so a stale entry
                // doesn't reappear on next JSON miss.
                let _ = keyring.delete(secret_ref);
                Ok(())
            }
            #[cfg(not(debug_assertions))]
            Self::Keyring(s) => s.delete(secret_ref),
        }
    }
}

pub struct ProfilesState {
    pub store: JsonFileStore,
    pub secrets: SecretBackend,
    pub service: String,
}

impl ProfilesState {
    pub fn new(profiles_path: PathBuf, service: impl Into<String>) -> Self {
        let config_dir = profiles_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let secrets = SecretBackend::new(&config_dir).unwrap_or_else(|err| {
            tracing::error!(
                ?err,
                "failed to open secret backend — falling back to keyring"
            );
            #[cfg(debug_assertions)]
            {
                // Fallback can't recover the dev-only file path here;
                // surface as keyring so the app still functions.
                SecretBackend::new(&PathBuf::from(".")).expect("secret backend init")
            }
            #[cfg(not(debug_assertions))]
            {
                SecretBackend::Keyring(KeyringStore::new())
            }
        });
        Self {
            store: JsonFileStore::new(profiles_path),
            secrets,
            service: service.into(),
        }
    }
}
