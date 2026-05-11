# plamenix-desktop

Tauri 2 shell for the Plamenix Firebird IDE — desktop edition.

This repo is one of five in the Plamenix polyrepo. For project-wide
context, see the [meta-workspace](https://github.com/zlatan/plamenix).

## Status

`1.0.0-beta` is in development. Mid-June 2026 ETA.

## Stack

- **Tauri 2.x** — windowing, IPC, native menus, packaging.
- **Rust 1.95** (edition 2024) — backend.
- **React 19 + TypeScript 6.0** — renderer.
- **Vite 8** — frontend build (port 1420).
- **Tailwind 4** — styling.
- **TanStack Query** — server state; **Zustand** — UI / per-tab state.

Consumes:

- `plamenix-core` (Rust) for shared types, driver, plugin host.
- `@plamenix/ui` (TypeScript) for shared React components and the
  `Transport` interface.

## Quick start

```bash
corepack enable
pnpm install
pnpm tauri dev
```

Requires `plamenix-core/` and `plamenix-ui/` checked out as siblings.

## Licence

Dual licensed under [MIT](./LICENSE-MIT) OR [Apache-2.0](./LICENSE-APACHE).
