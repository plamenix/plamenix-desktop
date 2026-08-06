//! Fetches the Firebird native client library from the official
//! GitHub release for the host platform, extracts just the client
//! library (`libfbclient.dylib` / `.so` / `fbclient.dll`), and saves
//! it under the application's data directory so the user does not
//! need a system-wide Firebird install to run in native mode.
//!
//! Platform notes:
//! - Linux: `Firebird-*-linux-<arch>.tar.gz` — straightforward.
//! - Windows: `Firebird-*-windows-<arch>.zip` — straightforward.
//! - macOS: `Firebird-*-macos-<arch>.pkg`. Apple `.pkg` archives are
//!   `xar` archives whose `Payload` is a gzip'd cpio. Both `xar` and
//!   `cpio` ship with macOS so we shell out rather than vendor a pure-
//!   Rust pkg extractor (which would be substantially larger code).

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use futures_util::StreamExt;
use tauri::AppHandle;
use tauri::Manager;
use thiserror::Error;

/// One Firebird release we know how to fetch from GitHub. The list is
/// pinned because the asset filenames embed the build number; users
/// who want a *different* point release can still Browse to a lib
/// they fetched themselves. Listed newest-first so the default is the
/// most recent stable.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct FirebirdRelease {
    /// Short label shown in the UI (e.g. `"5.0.3"`).
    pub version: &'static str,
    /// Full asset build segment in the download URL.
    pub build: &'static str,
    /// Bundle-tree subdirectory token (e.g. `"v50"`).
    pub major: &'static str,
}

pub const RELEASES: &[FirebirdRelease] = &[
    FirebirdRelease {
        version: "5.0.3",
        build: "5.0.3.1683-0",
        major: "v50",
    },
    FirebirdRelease {
        version: "4.0.5",
        build: "4.0.5.3140-0",
        major: "v40",
    },
    FirebirdRelease {
        version: "3.0.12",
        build: "3.0.12.33787-0",
        major: "v30",
    },
];

/// Convenience: latest release (`RELEASES[0]`). Used as the default
/// when no version label is supplied.
#[must_use]
pub fn latest_release() -> &'static FirebirdRelease {
    &RELEASES[0]
}

/// Looks up a release by its short version label (e.g. `"4.0.5"`).
#[must_use]
pub fn find_release(version: &str) -> Option<&'static FirebirdRelease> {
    RELEASES.iter().find(|r| r.version == version)
}

#[derive(Debug, Error)]
pub enum DownloadError {
    #[error("unsupported platform: {0}")]
    UnsupportedPlatform(String),
    #[error("http request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("archive extraction failed: {0}")]
    Extract(String),
    #[error("client library not found inside archive")]
    LibraryMissing,
    #[error("subprocess `{0}` failed: {1}")]
    Subprocess(&'static str, String),
}

/// Builds the GitHub release URL for the running host platform and
/// the supplied Firebird release.
fn release_url(release: &FirebirdRelease) -> Result<(String, &'static str), DownloadError> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let build = release.build;
    let asset = match (os, arch) {
        ("linux", "x86_64") => format!("Firebird-{build}-linux-x64.tar.gz"),
        ("linux", "aarch64") => format!("Firebird-{build}-linux-arm64.tar.gz"),
        ("macos", "x86_64") => format!("Firebird-{build}-macos-x64.pkg"),
        ("macos", "aarch64") => format!("Firebird-{build}-macos-arm64.pkg"),
        ("windows", "x86_64") => format!("Firebird-{build}-windows-x64.zip"),
        ("windows", "x86") => format!("Firebird-{build}-windows-x86.zip"),
        _ => return Err(DownloadError::UnsupportedPlatform(format!("{os}/{arch}"))),
    };
    let url = format!(
        "https://github.com/FirebirdSQL/firebird/releases/download/v{ver}/{asset}",
        ver = release.version,
    );
    let ext = if asset.ends_with(".tar.gz") {
        "tar.gz"
    } else if asset.ends_with(".pkg") {
        "pkg"
    } else {
        "zip"
    };
    Ok((url, ext))
}

/// Streams the release archive into `dest`. Returns the byte size for
/// telemetry.
async fn download_to(url: &str, dest: &Path) -> Result<u64, DownloadError> {
    // Reuse a single client so the connection pool + cookie store can
    // follow GitHub's `releases/download/*` 302 redirects to the
    // CDN-backed asset host without re-handshaking TLS for each hop.
    let client = reqwest::Client::builder()
        .user_agent(concat!("plamenix-desktop/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()?;
    let response = client.get(url).send().await?.error_for_status()?;
    let mut file = fs::File::create(dest)?;
    let mut total: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        total += chunk.len() as u64;
        file.write_all(&chunk)?;
    }
    Ok(total)
}

/// Filename the host-specific extractor writes into `out_dir`.
fn target_filename() -> &'static str {
    match std::env::consts::OS {
        "macos" => "libfbclient.dylib",
        "windows" => "fbclient.dll",
        _ => "libfbclient.so",
    }
}

/// Scans a `tar.gz` looking for the client library, copying the first
/// match into `out_dir/libfbclient.so`.
fn extract_tarball(archive: &Path, out_dir: &Path) -> Result<PathBuf, DownloadError> {
    let file = fs::File::open(archive)?;
    let mut tar = tar::Archive::new(GzDecoder::new(file));
    let target = out_dir.join(target_filename());
    for entry in tar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "libfbclient.so" || name.starts_with("libfbclient.so.") || name == "fbclient" {
            let mut out = fs::File::create(&target)?;
            std::io::copy(&mut entry, &mut out)?;
            return Ok(target);
        }
    }
    Err(DownloadError::LibraryMissing)
}

/// Scans a `.zip` for `fbclient.dll`.
fn extract_zip(archive: &Path, out_dir: &Path) -> Result<PathBuf, DownloadError> {
    let file = fs::File::open(archive)?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|err| DownloadError::Extract(err.to_string()))?;
    let target = out_dir.join(target_filename());
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|err| DownloadError::Extract(err.to_string()))?;
        let name = entry.name();
        if name.ends_with("/fbclient.dll") || name == "fbclient.dll" {
            let mut out = fs::File::create(&target)?;
            std::io::copy(&mut entry, &mut out)?;
            return Ok(target);
        }
    }
    Err(DownloadError::LibraryMissing)
}

/// Extracts a macOS Installer `.pkg` (xar + cpio Payload). Walks the
/// Payload tree looking for the embedded `libfbclient.dylib` inside
/// the framework bundle.
fn extract_pkg(archive: &Path, out_dir: &Path) -> Result<PathBuf, DownloadError> {
    let staging = tempfile::tempdir()?;
    // xar -xf <archive> -C <staging>
    let status = std::process::Command::new("xar")
        .arg("-xf")
        .arg(archive)
        .arg("-C")
        .arg(staging.path())
        .status()
        .map_err(|err| DownloadError::Subprocess("xar", err.to_string()))?;
    if !status.success() {
        return Err(DownloadError::Subprocess(
            "xar",
            format!("exit {}", status.code().unwrap_or(-1)),
        ));
    }
    // Find every Payload file and extract each with `cpio -i`.
    let payloads = find_payloads(staging.path())?;
    let work = tempfile::tempdir()?;
    for payload in payloads {
        // `cat payload | gzcat | cpio -i` — but Firebird's pkg Payload
        // is sometimes uncompressed cpio. Try gzip first; if that
        // fails the bytes are already cpio.
        let bytes = fs::read(&payload)?;
        let cpio_bytes = if bytes.starts_with(&[0x1f, 0x8b]) {
            let mut decoder = GzDecoder::new(bytes.as_slice());
            let mut out = Vec::new();
            decoder.read_to_end(&mut out)?;
            out
        } else {
            bytes
        };
        let cpio_path = work.path().join("payload.cpio");
        fs::write(&cpio_path, &cpio_bytes)?;
        // macOS BSD cpio doesn't accept `--quiet`; pipe stderr to
        // /dev/null instead. Some sub-package Payloads are metadata-
        // only and cpio exits non-zero on empty input — keep walking
        // so the framework's Payload still gets a chance.
        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "cd {} && cpio -idmu < {} 2>/dev/null",
                shell_escape(work.path().to_str().unwrap_or(".")),
                shell_escape(cpio_path.to_str().unwrap_or("")),
            ))
            .status()
            .map_err(|err| DownloadError::Subprocess("cpio", err.to_string()))?;
        if !status.success() {
            tracing::warn!(
                payload = %payload.display(),
                exit = ?status.code(),
                "cpio extraction returned non-zero; continuing"
            );
        }
    }
    let lib = find_dylib(work.path()).ok_or(DownloadError::LibraryMissing)?;
    let target = out_dir.join(target_filename());
    fs::copy(&lib, &target)?;
    Ok(target)
}

/// Recursively locates every file literally named `Payload` under
/// `root`. macOS `.pkg` archives contain one Payload per sub-package.
fn find_payloads(root: &Path) -> Result<Vec<PathBuf>, DownloadError> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out)?;
            } else if path.file_name().and_then(|n| n.to_str()) == Some("Payload") {
                out.push(path);
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(root, &mut out)?;
    Ok(out)
}

/// Recursively locates the first `libfbclient.dylib` (or symlink that
/// resolves into one) under `root`. The Firebird framework's main
/// binary is `Firebird.framework/Versions/A/Firebird`; the client
/// library is sometimes packaged alongside as
/// `Libraries/libfbclient.dylib`.
fn find_dylib(root: &Path) -> Option<PathBuf> {
    fn walk(dir: &Path) -> Option<PathBuf> {
        let mut framework_main: Option<PathBuf> = None;
        for entry in fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = walk(&path) {
                    return Some(found);
                }
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name == "libfbclient.dylib" {
                    return Some(path);
                }
                // Firebird.framework/Versions/A/Firebird is the
                // canonical entry point; remember it as a fallback so
                // we return *something* loadable even if a sub-package
                // does not ship a separate libfbclient.dylib.
                if name == "Firebird"
                    && path
                        .parent()
                        .and_then(|p| p.file_name())
                        .is_some_and(|n| n == "A")
                {
                    framework_main = Some(path);
                }
            }
        }
        framework_main
    }
    walk(root)
}

/// POSIX shell single-quoting. Used to build a `sh -c` command from
/// paths that may contain spaces.
fn shell_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Resolves the path to the fbclient library bundled inside the
/// app's resource directory, when one is present. The bundle layout
/// mirrors Firebird's macOS framework (`fbclient/v<XY>/Libraries/...`)
/// so identical paths work in `tauri dev` (reads straight from
/// `../resources/fbclient/...`) and in the released installer
/// (`<app>/Contents/Resources/fbclient/...` after Tauri copies the
/// tree). Returns `None` when no recognised file is found.
#[must_use]
pub fn bundled_path(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let fbclient_root = resource_dir.join("fbclient");
    if !fbclient_root.is_dir() {
        return None;
    }
    // Probe the most recent version first (v50 today; future major
    // bumps drop sibling directories). The bundle convention is one
    // major version per `v<MM>` subdir.
    for major in &["v50", "v40", "v30"] {
        let candidates: &[&[&str]] = match std::env::consts::OS {
            // `Resources/lib/libfbclient.dylib` is the working copy:
            // its `@rpath` resolves to `Resources/` so the sibling
            // `lib/libtommath.dylib` + `lib/libicu*.dylib` load
            // correctly. The framework's `Libraries/libfbclient.dylib`
            // also points at `@rpath/lib/libtommath.dylib`, but with
            // `@loader_path/..` as its rpath it ends up looking for
            // `<root>/lib/...` — directory that does not exist in the
            // Firebird .pkg payload. Probe the working copy first.
            "macos" => &[
                &["Resources", "lib", "libfbclient.dylib"],
                &["Libraries", "libfbclient.dylib"],
            ],
            "windows" => &[&["fbclient.dll"], &["bin", "fbclient.dll"]],
            _ => &[
                &["lib", "libfbclient.so"],
                &["lib", "libfbclient.so.5"],
                &["libfbclient.so"],
            ],
        };
        for tail in candidates {
            let mut p = fbclient_root.join(major);
            for seg in *tail {
                p = p.join(seg);
            }
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// Downloads, extracts, and stages the Firebird client library for
/// the supplied release under `app_data_dir/fbclient/<major>/`.
/// Returns the absolute path of the installed library. Per-major
/// subdirs let multiple downloads (e.g. v50 + v40) coexist; the
/// user-facing field stores whichever the user last selected.
pub async fn install(
    app_data_dir: PathBuf,
    release: &FirebirdRelease,
) -> Result<PathBuf, DownloadError> {
    let (url, ext) = release_url(release)?;
    let fbclient_dir = app_data_dir.join("fbclient").join(release.major);
    fs::create_dir_all(&fbclient_dir)?;
    let staging = tempfile::tempdir()?;
    let archive = staging.path().join(format!("firebird.{ext}"));
    tracing::info!(%url, version = release.version, "downloading Firebird client library");
    let size = download_to(&url, &archive).await?;
    tracing::info!(size, "download complete; extracting");
    let installed = match ext {
        "tar.gz" => extract_tarball(&archive, &fbclient_dir)?,
        "zip" => extract_zip(&archive, &fbclient_dir)?,
        "pkg" => extract_pkg(&archive, &fbclient_dir)?,
        _ => unreachable!(),
    };
    Ok(installed)
}
