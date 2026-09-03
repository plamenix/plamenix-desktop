#!/usr/bin/env bash
# Populates ../resources/fbclient/v<XY>/ with the Firebird client
# library and its dependencies for the host platform, so `tauri build`
# can include them in the installer.
#
# The repository ignores everything under resources/fbclient/, so each
# developer (or each release-pipeline runner) runs this once per
# platform before producing distributable bundles. The runtime
# downloader (`fbclient_download` Tauri command) is unrelated — it
# populates AppData, not the bundle.
#
# Usage:
#     scripts/fetch-fbclient.sh           # latest pinned release
#     scripts/fetch-fbclient.sh 4.0.5     # specific major
#
# Pin set is intentionally short and matches the RELEASES table in
# src-tauri/src/fbclient.rs. Override via FB_BUILD env var when a
# point release ships with a different build suffix.

set -euo pipefail

VERSION="${1:-5.0.3}"

case "$VERSION" in
    5.0.3) DEFAULT_BUILD="5.0.3.1683-0"; MAJOR_DIR="v50" ;;
    4.0.5) DEFAULT_BUILD="4.0.5.3140-0"; MAJOR_DIR="v40" ;;
    3.0.12) DEFAULT_BUILD="3.0.12.33787-0"; MAJOR_DIR="v30" ;;
    *) echo "Unsupported version: $VERSION"; exit 1 ;;
esac

BUILD="${FB_BUILD:-$DEFAULT_BUILD}"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
    Darwin-arm64) ASSET="Firebird-${BUILD}-macos-arm64.pkg"; EXT="pkg" ;;
    Darwin-x86_64) ASSET="Firebird-${BUILD}-macos-x64.pkg"; EXT="pkg" ;;
    Linux-x86_64) ASSET="Firebird-${BUILD}-linux-x64.tar.gz"; EXT="tar.gz" ;;
    Linux-aarch64) ASSET="Firebird-${BUILD}-linux-arm64.tar.gz"; EXT="tar.gz" ;;
    MINGW*-x86_64|MSYS*-x86_64) ASSET="Firebird-${BUILD}-windows-x64.zip"; EXT="zip" ;;
    *) echo "Unsupported platform: $OS-$ARCH"; exit 1 ;;
esac

URL="https://github.com/FirebirdSQL/firebird/releases/download/v${VERSION}/${ASSET}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ROOT}/resources/fbclient/${MAJOR_DIR}"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "→ downloading ${URL}"
curl -fL --retry 3 -o "${STAGING}/${ASSET}" "$URL"

mkdir -p "$DEST"

case "$EXT" in
    tar.gz)
        echo "→ extracting tarball into ${DEST}"
        tar -xzf "${STAGING}/${ASSET}" -C "$STAGING"
        # Firebird tarballs contain a `buildroot.tar.gz` that holds the
        # actual file tree rooted at /opt/firebird. Untar it into the
        # staging tree first, then copy what we need.
        # The release tarball unpacks to a versioned directory —
        # `Firebird-5.0.3.1683-0-linux-x64/` — so `buildroot.tar.gz` is
        # one level down, not at the staging root. Searching for it
        # keeps this working if the layout shifts again.
        BUILDROOT="$(find "$STAGING" -maxdepth 3 -type f -name buildroot.tar.gz | head -n1)"
        if [ -n "$BUILDROOT" ]; then
            tar -xzf "$BUILDROOT" -C "$STAGING"
        fi
        FB_ROOT="$(find "$STAGING" -type d -name firebird | head -n1)"
        if [ -z "$FB_ROOT" ]; then
            echo "could not locate firebird/ inside tarball"; exit 1
        fi
        # Take lib/, plugins/, and firebird.conf — enough for fbclient
        # to attach without a system-wide install.
        cp -R "${FB_ROOT}/lib" "${DEST}/"
        cp -R "${FB_ROOT}/plugins" "${DEST}/" 2>/dev/null || true
        cp "${FB_ROOT}/firebird.conf" "${DEST}/" 2>/dev/null || true
        cp "${FB_ROOT}/plugins.conf" "${DEST}/" 2>/dev/null || true
        ;;
    zip)
        echo "→ extracting zip into ${DEST}"
        unzip -q "${STAGING}/${ASSET}" -d "$STAGING"
        FB_ROOT="$(find "$STAGING" -maxdepth 2 -type d -name 'Firebird-*' | head -n1)"
        if [ -z "$FB_ROOT" ]; then
            FB_ROOT="$STAGING"
        fi
        # Windows distribution layout: top-level fbclient.dll +
        # icu*.dll + plugins/ + firebird.conf. Copy everything we
        # need; the dev can prune later if installer size matters.
        for f in fbclient.dll icudt*.dll icuuc*.dll icuin*.dll \
                  msvcp140.dll vcruntime140.dll firebird.conf plugins.conf; do
            cp "${FB_ROOT}/${f}" "$DEST/" 2>/dev/null || true
        done
        if [ -d "${FB_ROOT}/plugins" ]; then
            cp -R "${FB_ROOT}/plugins" "$DEST/"
        fi
        ;;
    pkg)
        echo "→ extracting macOS .pkg into ${DEST}"
        xar -xf "${STAGING}/${ASSET}" -C "$STAGING"
        WORK="${STAGING}/work"
        mkdir -p "$WORK"
        # Walk every Payload (one per sub-package) and feed it to
        # cpio. Some payloads are gzip-wrapped, others raw cpio.
        while IFS= read -r payload; do
            (
                cd "$WORK"
                # Probe gzip magic; fall through to plain cpio on miss.
                if gunzip -t "$payload" 2>/dev/null; then
                    gunzip -c "$payload" | cpio -idum 2>/dev/null || true
                else
                    cpio -idum < "$payload" 2>/dev/null || true
                fi
            )
        done < <(find "$STAGING" -name Payload)
        # Firebird's .pkg Payload is laid out as a flattened
        # Firebird.framework tree — the work dir itself contains
        # `Versions/A/Libraries/libfbclient.dylib` plus the
        # framework's top-level symlinks. Treat $WORK as the
        # framework root.
        if [ ! -d "${WORK}/Versions/A/Libraries" ]; then
            echo "could not locate Versions/A/Libraries inside .pkg payload"; exit 1
        fi
        # Copy framework's resolvable Versions/A tree under
        # v<XY>/{Libraries,Resources,Headers} — same layout that
        # `bundled_path()` already probes.
        cp -R "${WORK}/Versions/A/Libraries" "$DEST/" 2>/dev/null || true
        cp -R "${WORK}/Versions/A/Resources" "$DEST/" 2>/dev/null || true
        cp -R "${WORK}/Versions/A/Headers" "$DEST/" 2>/dev/null || true
        ;;
esac

echo "✓ fbclient ${VERSION} ready under ${DEST}"
