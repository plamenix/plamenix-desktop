//! Connect-smoke for every saved profile.
//!
//! Diagnostic harness for the M1 freeze-day issue where
//! `profile_connect` Tauri command fails for every profile in the live
//! desktop app. The example mirrors the command's chain end-to-end
//! WITHOUT the Tauri command layer:
//!
//!   1. Read `~/Library/Application Support/dev.plamenix.desktop/profiles.json`
//!   2. For each profile, resolve the password from the OS keyring
//!      (service `dev.plamenix.desktop`, account `profile:<id>:password`).
//!   3. Build a `ConnectionConfig` matching what
//!      `resolve_connection_config` produces inside the command.
//!   4. Attempt a connect via `RsfbDriver` in BOTH `Native` (bundled
//!      `libfbclient.dylib`) and `PureRust` modes.
//!   5. Print a per-profile, per-mode pass/fail row.
//!
//! Run:
//!
//! ```sh
//! cargo run --release --example connect_all_profiles \
//!   -p plamenix-desktop
//! ```
//!
//! The harness reads the production keychain entries the running
//! `Plamenix.app` would read. macOS may prompt once per keychain entry
//! the first time this binary is run (cargo + Plamenix.app have
//! different code-signing hashes, so the ACL `-A` flag the populator
//! script set may or may not suffice — accept "Always Allow" once.)

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::path::PathBuf;

use plamenix_db::{ConnectMode, DbDriver, RsfbDriver};
use plamenix_profiles::{
    ConnectOverrides, Profile, ProfileStore, RuntimeSecrets, resolve_connection_config,
};
use plamenix_secrets::KeyringStore;
use plamenix_types::ConnectionConfig;

const SERVICE: &str = "dev.plamenix.desktop";
const BUNDLED_FBCLIENT_REL: &str = "resources/fbclient/v50/Libraries/libfbclient.dylib";

fn profiles_path() -> PathBuf {
    let home = std::env::var_os("HOME").expect("HOME unset");
    PathBuf::from(home)
        .join("Library/Application Support")
        .join(SERVICE)
        .join("profiles.json")
}

fn bundled_fbclient_path() -> Option<PathBuf> {
    // Resolves to the desktop repo checkout's resource tree so the example
    // can run from any CWD inside the workspace.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest_dir.parent()?.join(BUNDLED_FBCLIENT_REL);
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn load_profiles() -> Vec<Profile> {
    let path = profiles_path();
    let store = plamenix_profiles::JsonFileStore::new(&path);
    store
        .list()
        .unwrap_or_else(|err| panic!("read profiles.json at {}: {err}", path.display()))
}

fn build_config(profile: &Profile) -> Result<ConnectionConfig, String> {
    let keyring = KeyringStore::new();
    let runtime = RuntimeSecrets {
        password: None,
        encryption_key: None,
    };
    let overrides = ConnectOverrides {
        pure_rust: None,
        encryption_required: None,
        fbclient_path: bundled_fbclient_path().map(|p| p.to_string_lossy().into_owned()),
        charset: None,
    };
    resolve_connection_config(profile, &keyring, SERVICE, &runtime, &overrides)
        .map_err(|err| err.to_string())
}

async fn try_connect(driver: &RsfbDriver, config: ConnectionConfig, mode: ConnectMode) -> String {
    match driver.connect(config, mode).await {
        Ok(session) => format!("ok session={session:?}"),
        Err(err) => format!("ERR {err}"),
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let profiles = load_profiles();
    let bundled = bundled_fbclient_path();
    println!("profiles loaded: {}", profiles.len());
    println!(
        "bundled fbclient: {}",
        bundled
            .as_ref()
            .map_or("<not found>".to_string(), |p| p.display().to_string()),
    );
    println!();

    let driver = RsfbDriver::new();

    let mut ok_native = 0usize;
    let mut ok_pure = 0usize;
    for profile in &profiles {
        let label = format!("{:<28}", profile.name);
        let config = match build_config(profile) {
            Ok(c) => c,
            Err(err) => {
                println!("{label} cfg-error: {err}");
                continue;
            }
        };
        // Print resolved minus password so anyone reading the log can
        // confirm the host/port/db/user/charset/fbclient_path landed
        // where they expect without exposing the keychain value.
        println!(
            "{label} host={} port={} db={} user={} charset={:?} fbclient_path_set={}",
            config.host,
            config.port,
            config.database,
            config.user,
            config.charset.as_deref().unwrap_or("UTF8"),
            config.fbclient_path.is_some(),
        );

        let native_outcome = try_connect(&driver, config.clone(), ConnectMode::Native).await;
        if native_outcome.starts_with("ok") {
            ok_native += 1;
        }
        println!("  native    : {native_outcome}");

        let pure_outcome = try_connect(&driver, config, ConnectMode::PureRust).await;
        if pure_outcome.starts_with("ok") {
            ok_pure += 1;
        }
        println!("  pure-rust : {pure_outcome}");
    }

    println!();
    println!(
        "summary: native {}/{}, pure-rust {}/{}",
        ok_native,
        profiles.len(),
        ok_pure,
        profiles.len(),
    );
}
