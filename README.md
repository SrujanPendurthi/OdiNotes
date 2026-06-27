# OdiNotes

A lightweight, hyper-efficient Markdown note-taking app (Obsidian-style) built
with **Tauri v2 + Rust** and a **vanilla TypeScript + Vite + Tailwind** frontend.
Optimised for minimal RAM and CPU on macOS and Linux.

## Features

- **Vault model** — point the app at any folder; it becomes your note vault.
- **Live inline preview** — bold, italics, headings, strikethrough and inline
  code render in place as you type (CodeMirror 6); raw syntax markers reveal
  only when the cursor enters them.
- **Create files & folders** from inside the app (toolbar or right-click menu).
- **Drag to reorganise** — drag a note or folder onto another folder to nest it,
  or onto empty sidebar space to move it to the vault root.
- **Auto-save** — edits flush to disk ~400 ms after you stop typing.
- **Tiny footprint** — native webview (no Electron), size-optimised release
  profile, lazy-loaded syntax grammars.

## Tech stack

| Layer    | Choice                                            |
| -------- | ------------------------------------------------- |
| Backend  | Rust (Tauri v2), `tauri-plugin-dialog`            |
| Frontend | Vanilla TypeScript, Vite, Tailwind CSS            |
| Editor   | CodeMirror 6 with a custom live-preview decorator |
| Storage  | Local filesystem (`.md` files in a vault folder)  |

## Project layout

```text
/
├── index.html               # Frontend entry
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── tsconfig.json
├── scripts/gen-icon.mjs     # Zero-dep placeholder icon generator
├── src/                     # Frontend source
│   ├── main.ts              # App shell: sidebar, file tree, auto-save
│   ├── editor.ts            # CodeMirror live-preview editor
│   ├── vault.ts             # Typed wrappers over Rust commands
│   └── style.css
└── src-tauri/               # Rust backend
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/default.json
    └── src/main.rs          # list_tree / read / write / create commands
```

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable)
- macOS: Xcode Command Line Tools. Linux: the
  [Tauri system dependencies](https://tauri.app/start/prerequisites/).

## Getting started

```bash
npm install

# (Re)generate app icons if needed
node scripts/gen-icon.mjs && npx tauri icon app-icon.png

# Run in development (hot-reloads frontend + Rust)
npm run tauri dev

# Build a distributable bundle
npm run tauri build
```

On first launch click **Open Vault…**, choose a folder, then create or open a
note. The last-used vault is remembered between sessions.

## Docker

OdiNotes is a desktop GUI app, so Docker is **not** for running it — it's a
reproducible environment that bundles the build/dev dependencies. See the
`Dockerfile` header for details. Two uses:

```bash
# Build Linux bundles (.deb/.AppImage) into ./artifacts — no local Rust/Node needed.
# Linux only; a macOS .app/.dmg can't be produced in a container.
DOCKER_BUILDKIT=1 docker build --target export -o ./artifacts .

# Frontend dev server with hot reload (native APIs unavailable) → http://localhost:1420
docker compose up dev

# Type-check + production frontend build (the repo's correctness gate)
docker compose run --rm typecheck
```

## Backend commands

`src-tauri/src/main.rs` exposes five Tauri commands, invoked from `vault.ts`:

- `list_tree(path)` → recursive tree of folders and `.md` files
- `read_file(path)` / `write_file(path, contents)`
- `create_file(dir, name)` / `create_dir(parent, name)`
- `move_path(src, dest_dir)` → move a file/folder into another folder

## Install as a Mac app

To use OdiNotes like any other Mac app — launched from Spotlight/Launchpad/Dock,
working with no terminal open — build a production bundle and copy it into
`/Applications`. One command does both:

\`\`\`bash
npm run build:install
\`\`\`

This runs `npm run tauri build` (type-check, frontend build, size-optimised
release compile) and copies the resulting `OdiNotes.app` into `/Applications`,
replacing any previous install. Launch it from Spotlight (`⌘Space` → "OdiNotes"),
Launchpad, or the Applications folder.

The installed app is a snapshot — re-run `npm run build:install` to pick up
source changes. A locally built app has no quarantine flag, so Gatekeeper launches
it cleanly; if macOS ever blocks it, run
`xattr -dr com.apple.quarantine /Applications/OdiNotes.app`.
