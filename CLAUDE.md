# plamenix-desktop

Tauri 2 shell for the Plamenix desktop edition. Hosts the React UI in a
WebView, registers Tauri commands, owns the splash + main window pair,
and consumes the shared crates (`plamenix-core`) and shared React
library (`@plamenix/ui`).

For cross-repo architectural context (driver, plugin system, transport,
state, splash, encryption, web edition), read the specs in
`../plamenix/docs/` and the ADRs in `../plamenix/docs/adr/`.

## Layout

```
src/                    React renderer
  main.tsx              main-window entry (QueryClientProvider, App)
  splash.tsx            splash-window entry (no React Query, no Zustand)
  App.tsx               shell stub
  transport/tauri.ts    `Transport` impl backed by `@tauri-apps/api/core` invoke
  styles/globals.css    Tailwind 4 entry

src-tauri/              Rust backend
  Cargo.toml            crate `plamenix-desktop`, depends on `plamenix-types`
  build.rs              `tauri_build::build()`
  tauri.conf.json       two windows (splash visible, main hidden until boot:ready)
  capabilities/         per-window capability files
  src/main.rs           binary entry, tracing init, delegates to lib::run()
  src/lib.rs            tauri::Builder, command handlers, splash orchestration
  src/boot.rs           boot:step / finish helpers
  src/commands/mod.rs   tauri::command handlers (ping for now)

index.html              main-window HTML shell
splash.html             splash-window HTML shell
package.json            React shell, peer @plamenix/ui via file: in dev
tsconfig.json           strict + noUncheckedIndexedAccess
vite.config.ts          two Rollup entries (main + splash), port 1420
```

## Build / dev

```
just setup     # pnpm install + cargo fetch
just dev       # `pnpm tauri dev` — spawns Vite + Tauri together
just build     # production bundles per platform
just lint      # cargo clippy + eslint
just fmt       # cargo fmt + prettier
just test      # cargo test + vitest
```

The dev command requires `plamenix-core` to be present at
`../plamenix-core/` (sibling repo). `Cargo.toml` uses a `path =`
dependency for local development; release builds will swap to crates.io.

`@plamenix/ui` is consumed via `file:../plamenix-ui` in `package.json`
for local dev. Once `@plamenix/ui` is published to npm, swap to a
SemVer range and drop the file: link.

## Code rules (repo-specific)

- Tauri commands live under `src-tauri/src/commands/`. One file per
  concern. Register them in `lib.rs` via `tauri::generate_handler!`.
- No business logic in `commands/`. Commands are thin adapters: parse
  input, call into `plamenix-core` (or, later, `plamenix-db`), emit
  events, return typed responses.
- Splash code in `splash.tsx` has zero state-management dependencies.
  Subscribe to `boot:step` events, render a label.
- Two-window setup: never make the main window visible before
  `boot::finish()` runs; never leave the splash window open after.
- Tracing: `tracing::info!` / `warn!` / `error!` at boundary events.
  No `println!`, no `dbg!`.

## What does not live here

- Database driver wiring — lives in `plamenix-core` (`plamenix-db`
  crate, to come).
- Reusable React components — live in `plamenix-ui`.
- Plugin host runtime — lives in `plamenix-core`.
- Web edition Fastify server — lives in `plamenix-web`.

If a rule is missing from this file, the parent workspace `CLAUDE.md`
applies. Cross-repo architectural specs live in `../plamenix/docs/`.
