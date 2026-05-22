//! Tauri command wrapping the platform-specific Firebird client
//! downloader from `crate::fbclient`.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::fbclient::{RELEASES, bundled_path, find_release, install, latest_release};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbclientDownloadResult {
    /// Absolute path of the installed client library on disk.
    pub path: String,
    /// Firebird version that was downloaded.
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbclientReleaseInfo {
    pub version: String,
    pub major: String,
}

/// Lists every Firebird release the in-app downloader knows how to
/// fetch. Renderer uses this to populate the version dropdown next to
/// the Download button.
#[tauri::command]
#[tracing::instrument(name = "cmd.fbclient_list_releases")]
pub fn fbclient_list_releases() -> Vec<FbclientReleaseInfo> {
    RELEASES
        .iter()
        .map(|r| FbclientReleaseInfo {
            version: r.version.to_string(),
            major: r.major.to_string(),
        })
        .collect()
}

#[tauri::command]
#[tracing::instrument(name = "cmd.fbclient_download", skip(app))]
pub async fn fbclient_download(
    app: AppHandle,
    version: Option<String>,
) -> Result<FbclientDownloadResult, String> {
    let release = match version.as_deref() {
        Some(v) => find_release(v)
            .ok_or_else(|| format!("unknown Firebird version: {v}"))?,
        None => latest_release(),
    };
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("resolve app_data_dir: {err}"))?;
    match install(app_data_dir, release).await {
        Ok(installed) => {
            tracing::info!(path = %installed.display(), version = release.version, "fbclient installed");
            Ok(FbclientDownloadResult {
                path: installed.to_string_lossy().into_owned(),
                version: release.version.to_string(),
            })
        }
        Err(err) => {
            let mut chain = err.to_string();
            let mut source: Option<&dyn std::error::Error> = std::error::Error::source(&err);
            while let Some(s) = source {
                chain.push_str(" -> ");
                chain.push_str(&s.to_string());
                source = s.source();
            }
            tracing::error!(error = %chain, "fbclient download failed");
            Err(chain)
        }
    }
}

/// Returns the path to the fbclient library bundled with the
/// installer, or `null` when no such resource is present (alternate
/// platforms, dev builds without a populated `resources/fbclient/`,
/// or future repositioning of the bundle).
#[tauri::command]
#[tracing::instrument(name = "cmd.fbclient_bundled_path", skip(app))]
pub fn fbclient_bundled_path(app: AppHandle) -> Option<String> {
    bundled_path(&app).map(|p| p.to_string_lossy().into_owned())
}

/// Outcome of inspecting a directory the user pointed at via the
/// "EPF folder" picker. `fbclientPath` is `Some(...)` when a host
/// fbclient binary was found in the directory; the encryption plugin
/// + OpenSSL flags indicate whether the IBSurgeon EPF trio is
/// complete. The host validates server-side rather than in JS so the
/// `.dll` / `.dylib` / `.so` selection logic lives in one place.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FbclientDirInspection {
    pub fbclient_path: Option<String>,
    pub has_fbcrypt: bool,
    pub has_openssl: bool,
}

#[tauri::command]
#[tracing::instrument(name = "cmd.fbclient_inspect_dir", fields(dir = %dir))]
pub fn fbclient_inspect_dir(dir: String) -> FbclientDirInspection {
    let root = std::path::PathBuf::from(&dir);
    if !root.is_dir() {
        return FbclientDirInspection {
            fbclient_path: None,
            has_fbcrypt: false,
            has_openssl: false,
        };
    }
    let entries: Vec<String> = match std::fs::read_dir(&root) {
        Ok(it) => it
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .collect(),
        Err(_) => Vec::new(),
    };

    let fbclient_name = entries.iter().find(|n| {
        matches!(
            n.as_str(),
            "fbclient.dll" | "libfbclient.dylib" | "libfbclient.so"
        ) || n.starts_with("libfbclient.so.")
    });
    let fbclient_path = fbclient_name.map(|n| root.join(n).to_string_lossy().into_owned());

    let has_fbcrypt = entries.iter().any(|n| {
        let lower = n.to_ascii_lowercase();
        lower == "fbcrypt.dll" || lower == "libfbcrypt.dylib" || lower == "libfbcrypt.so"
    });
    let has_openssl = entries.iter().any(|n| {
        let lower = n.to_ascii_lowercase();
        // OpenSSL ships under several filename conventions: numbered
        // builds (`openssl3.dll`), unversioned (`libssl.dylib`), and
        // SO-named variants (`libssl.so.3`).
        lower.starts_with("openssl")
            || lower.starts_with("libssl.")
            || lower.starts_with("libcrypto.")
    });

    FbclientDirInspection {
        fbclient_path,
        has_fbcrypt,
        has_openssl,
    }
}
