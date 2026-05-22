# Specs — @plamenix/desktop

## Purpose

Plamenix — Firebird IDE, desktop edition (Tauri 2 shell).

## Tech stack

- Node.js
- React
- Vite
- Tauri
- Tailwind CSS
- TypeScript

## Top-level layout

```
.gitignore
CLAUDE.md
CODE_OF_CONDUCT.md
CONTRIBUTING.md
LICENSE-APACHE
LICENSE-MIT
README.md
eslint.config.js
index.html
justfile
package.json
pnpm-lock.yaml
postcss.config.js
public/
resources/
rust-toolchain.toml
rustfmt.toml
scripts/
splash.html
src/
src-tauri/
tailwind.config.ts
tsconfig.json
vite.config.ts
```

## Status

Work in progress — iterating in private. No published release contract yet.

## Open questions / TODO

- [ ] Document deployment target
- [ ] Add minimal smoke tests
- [ ] Document required env vars (see `.env.example` if present)
