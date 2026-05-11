default:
    @just --list

# Install JS deps + verify Rust toolchain
setup:
    pnpm install
    cd src-tauri && cargo fetch

# Run the desktop app in dev mode (Tauri spawns Vite)
dev:
    pnpm tauri dev

# Production build (bundled installers per platform)
build:
    pnpm tauri build

# Type-check React side
typecheck:
    pnpm tsc --noEmit

# Lint Rust + JS
lint:
    cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
    pnpm eslint .

# Format Rust + JS
fmt:
    cd src-tauri && cargo fmt --all
    pnpm prettier --write .

# Run tests
test:
    cd src-tauri && cargo test --all-features
    pnpm vitest run

# Regenerate Tauri icon set + favicons from the branding sibling repo.
# Run after a plamenix-branding update.
refresh-icons:
    pnpm tauri icon ../plamenix-branding/build/icon/icon-1024.png
    rm -rf public/favicon
    mkdir -p public/favicon
    cp ../plamenix-branding/build/favicon/* public/favicon/
