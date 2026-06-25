# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

OdiNotes is a lightweight, Obsidian-style Markdown note-taking app: a Tauri v2 + Rust
backend with a vanilla TypeScript + Vite + Tailwind frontend, optimized for low RAM/CPU on
macOS and Linux. There is no Electron and no framework — everything is hand-rolled DOM.

## Commands

```bash
npm install                 # install frontend deps
npm run tauri dev           # run the desktop app (hot-reloads frontend + Rust)
npm run tauri build         # build a distributable bundle
npm run dev                 # frontend-only Vite server on :1420 (no native APIs available)
npm run build               # tsc --noEmit type-check + vite build (use this to type-check)

# Regenerate app icons (only when the icon changes)
node scripts/gen-icon.mjs && npx tauri icon app-icon.png
```

There is no test suite and no linter configured. `npm run build` is the only correctness gate
(TypeScript type-check). For Rust, `cd src-tauri && cargo check`.

## Architecture

The app is a single window split into three layers that talk over Tauri's `invoke` bridge.

**Rust backend (`src-tauri/src/main.rs`)** — six stateless `#[tauri::command]`s, all operating
on absolute path strings: `list_tree`, `read_file`, `write_file`, `create_file`, `create_dir`,
`move_path`. `build_tree` recursively walks a folder, skipping dotfiles and non-`.md` files,
returning a `FileNode { name, path, is_dir, children }` tree (folders first, then
case-insensitive sort). The backend holds no state — the vault path lives in the frontend.
New commands must be added to `invoke_handler!` in `main()` **and** to `capabilities/default.json`
permissions if they need new capabilities.

**Frontend `vault.ts`** — the only place that calls `invoke`. Thin typed wrappers around each
Rust command plus `pickVault` (native folder dialog). Keep all backend coupling here; the rest
of the frontend imports from this module, never `@tauri-apps/api` directly.

**Frontend `main.ts`** — the app shell and all state (module-level `let`s: `vaultPath`,
`currentFile`, `activeDir`, `tree`, `collapsed`, `dragSrcPath`). Responsibilities: renders the
sidebar file tree imperatively (no virtual DOM — `renderTree()` rebuilds from `tree`), debounced
auto-save (~400 ms after typing stops), fuzzy file search via `fzf` (⌘/Ctrl+K), drag-and-drop to
move files/folders, the right-click context menu, and a custom `promptModal` (Tauri webviews
have no `window.prompt`). The last vault is persisted in `localStorage` under `odinotes.vault`.

**Frontend `editor.ts`** — a CodeMirror 6 instance wrapped behind the `EditorHandle` interface
(`setDoc`/`getDoc`/`focus`/`destroy`). This is the most intricate file. Three custom pieces layer
on top of CodeMirror:
- **`livePreview` ViewPlugin** — Obsidian-style inline rendering. Walks the Lezer syntax tree and
  applies `Decoration.mark` for styling (bold/italic/headings/etc.) while `Decoration.replace`
  *hides* the raw syntax markers (`#`, `**`, `` ` ``, `~~`) unless a selection touches them.
- **`hangingIndent` ViewPlugin** — soft-wrapped lines align under their content (past list
  markers) via per-line negative `text-indent` + matching `padding-left`.
- **List-aware Tab handling** — `indentList`/`outdentList` keymap commands (registered before
  `defaultKeymap`) nest/promote whole Markdown list items including children, then
  `renumberOrderedLists` rewrites ordered-list numbers as one undo step. These return `false`
  outside a list so generic `indentMore`/`indentLess` take over.

### Data flow

`main.ts` is the controller: user action → `vault.ts` invoke → mutate state → re-render. The
editor never touches the filesystem; it only emits doc changes via the `onChange` callback, which
`main.ts` debounces into `writeFile`. When switching files, `main.ts` flushes the pending save
before loading the next file, and sets `suppressChange` so the load itself doesn't trigger a save.

## Conventions & gotchas

- **Path handling is POSIX-only** (`dirname`/`basename`/`relativeToVault` in `main.ts` split on
  `/`). The app targets macOS/Linux; Windows paths are not handled.
- **`dragDropEnabled: false`** in `tauri.conf.json` is intentional — Tauri's native file drag-drop
  otherwise swallows HTML5 drag events the sidebar relies on for moving files.
- **Tailwind uses semantic color tokens** (`bg`, `fg`, `panel`, `border`, `muted`, `accent`)
  defined in `tailwind.config.js`, not raw colors. Use those tokens for consistency with the
  dark theme.
- **Performance is a product goal.** The release profile in `src-tauri/Cargo.toml` is tuned for
  size (`opt-level="s"`, `lto`, `panic="abort"`, `strip`), Vite targets a lean bundle, and
  CodeMirror language grammars are lazy-loaded. Prefer solutions that keep the footprint small.
- The frontend deliberately avoids any UI framework. Match the existing imperative-DOM style when
  extending the sidebar or modals.
