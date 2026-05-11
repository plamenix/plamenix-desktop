# Contributing to plamenix-desktop

Thanks for your interest. This repo holds the Tauri 2 shell for the
Plamenix desktop edition. Cross-cutting guidance lives in the
[meta-workspace `CONTRIBUTING.md`](../plamenix/CONTRIBUTING.md). This
file covers desktop-specific bits.

## Prerequisites

- Rust 1.95 (`rustup default 1.95`)
- Node 24 + pnpm via Corepack (`corepack enable`)
- Tauri 2 system dependencies for your platform — see
  https://tauri.app/start/prerequisites/

## Local development

```bash
pnpm install
pnpm tauri dev
```

The dev command starts Vite on port 1420 and spawns Tauri pointing at
it. Edits to `src/` hot-reload; edits to `src-tauri/` trigger a Rust
rebuild.

`plamenix-core/` and `plamenix-ui/` must be checked out as siblings of
this repo. Local path overrides are already wired (`Cargo.toml` →
`path = "../../plamenix-core/..."`; `package.json` → `file:../plamenix-ui`).

## Code style

- Rust: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`. Lint
  configuration is set at the workspace level in `Cargo.toml`.
- TypeScript: `pnpm prettier --write .`, `pnpm eslint .`. No `any`.
- Functions over classes. Small modules. See `../plamenix/docs/principles.md`.

## Commits

Conventional Commits: `feat(desktop): …`, `fix(desktop): …`,
`docs:`, `chore:`. See `../plamenix/docs/git-workflow.md`.

## Tests

```bash
cd src-tauri && cargo test --all-features
pnpm vitest run
```

## Licence of contributions

By submitting a PR you agree your contribution is dual-licensed under
MIT OR Apache-2.0.
