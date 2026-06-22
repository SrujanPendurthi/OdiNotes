# OdiNotes

A lightweight, hyper-efficient Markdown note-taking app (Obsidian-style) built
with **Tauri v2 + Rust** and a **vanilla TypeScript + Vite + Tailwind** frontend.
Optimised for minimal RAM and CPU on macOS and Linux.

## Features

- **Vault model** — point the app at any folder; it becomes your note vault.
- **Live inline preview** — bold, italics, headings, strikethrough and inline
  code render in place as you type (CodeMirror 6); raw syntax markers reveal
  only when the cursor enters them.
- **Create files & folders** from inside the app.
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

## Backend commands

`src-tauri/src/main.rs` exposes five Tauri commands, invoked from `vault.ts`:

- `list_tree(path)` → recursive tree of folders and `.md` files
- `read_file(path)` / `write_file(path, contents)`
- `create_file(dir, name)` / `create_dir(parent, name)`
