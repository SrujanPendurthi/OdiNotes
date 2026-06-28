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

The app is a single window split into layers that talk over Tauri's `invoke` bridge. A thin top
bar (sidebar toggle + a drag region) spans the window above a sidebar/editor split. The editor
area hosts a **tree of panes** (tmux-style splits); each pane owns its own tab strip + editor.

**Rust backend (`src-tauri/src/main.rs`)** — six stateless `#[tauri::command]`s, all operating
on absolute path strings: `list_tree`, `read_file`, `write_file`, `create_file`, `create_dir`,
`move_path`. `build_tree` recursively walks a folder, skipping dotfiles and non-`.md` files,
returning a `FileNode { name, path, is_dir, children }` tree (folders first, then
case-insensitive sort). The backend holds no state — the vault path lives in the frontend.
New commands must be added to `invoke_handler!` in `main()` **and** to `capabilities/default.json`
permissions if they need new capabilities. The `setup` hook also calls `apply_overlay_titlebar`
on macOS (see the titlebar note below); that's the only non-command native code, and it uses the
`objc` crate gated behind `cfg(target_os = "macos")`.

**Frontend `vault.ts`** — the only place that calls `invoke`. Thin typed wrappers around each
Rust command plus `pickVault` (native folder dialog). Keep all backend coupling here; the rest
of the frontend imports from this module, never `@tauri-apps/api` directly.

**Frontend `paths.ts`** — POSIX-only path helpers (`basename`/`dirname`/`relativeToVault`, split
on `/`) shared by `main.ts` and `pane.ts`. The app targets macOS/Linux; Windows paths aren't handled.

**Frontend `pane.ts`** — the `Pane` class: a single editor pane owning its **tab strip** + one
CodeMirror view, plus the set of open tabs and the active one. A pane manages only its own
tabs/editor (`openFile`/`activateTab`/`closeTab`/`forgetTabs`/`remap`/`serialize`/`restore`) and its
own debounced auto-save (~400 ms after typing stops, `scheduleSave`/`flushSave`); it touches the
filesystem only via `readFile`/`writeFile`. It stays *dumb* about workspace concerns — all
filesystem-affecting decisions and cross-pane state live in `main.ts`. A pane talks back to the
controller through the `PaneDeps` callbacks (`onActivate`, `onActiveChange`, `onNewNote`,
`onSaveStatus`, `onSplit`, `onClosePane`). Any mouse/focus interaction inside a pane makes it the
active pane. The tab strip carries a pinned controls cluster (split + close-pane buttons) on the
right; `setCanClose` hides the close-pane button when there's only one pane.

**Frontend `main.ts`** — the workspace controller and all shell state (module-level `let`s:
`vaultPath`, `activeDir`, `tree`, `collapsed`, `dragSrcPath`, `sidebarCollapsed`, plus the pane tree
`root`/`activePane` and the `currentFile`/`tabs` **mirrors** of the active pane). The editor area is
a binary **pane tree** (`PNode = leaf | split{dir:"row"|"col", a, b}`); `renderPanes`/`buildNode`
rebuild `#editor-wrap` from it (reusing pane DOM nodes), drag dividers resize splits (`startResize`).
Split ops: `splitActive(dir, target?)`, `closePane(target?)` (keeps ≥1 pane), `cyclePane`, and
spatial `focusDir`/`paneInDirection` (default to `activePane`; pane buttons pass an explicit target).
These are driven by a **Vim-independent multiplexer layer** (`muxDispatch`, a capture-phase handler
registered before `vimDispatch`): a tmux-style prefix (`Ctrl-b`, alias `Ctrl-l`) arms `muxPending`,
then the next key splits (`v`/`s`), closes (`x`/`c`/`q`), cycles (`o`/`w`), or moves focus
(`h/j/k/l` or arrows). It runs regardless of Vim mode and uses `stopImmediatePropagation` so consumed
keys never reach `vimDispatch`, the bubble-phase shortcuts, or the editor. The split layout is
**never persisted** — only the active pane's tabs are. `openFile` is a thin router to
`activePane.openFile`;
any sidebar/search click opens the file in the active pane's tab (focusing it if already open). Other
responsibilities: the sidebar file tree rendered imperatively (no virtual DOM — `renderTree()`
rebuilds from `tree`), fuzzy file search via `fzf` (⌘/Ctrl+K), drag-and-drop to move files/folders
(`applyPathChange` remaps tabs across **all** panes via `pane.remap`; trashing uses `forgetTabs`),
the right-click context menu, a **Settings menu** (gear button in the sidebar footer, built on the
same `mountMenu` machinery as the context menu — currently a single persisted "Vim mode" toggle),
and a custom `promptModal` (Tauri webviews have no `window.prompt`).
Persisted in `localStorage`: the vault (`odinotes.vault`), sidebar-collapsed state
(`odinotes.sidebarCollapsed`), the active pane's open tabs + active tab (`odinotes.tabs`, restored on
boot for files that still exist), and the Vim toggle (`odinotes.vim`). Keyboard shortcuts wired here:
⌘/Ctrl+K (search), ⌘/Ctrl+W (close tab), Ctrl+Tab / Ctrl+Shift+Tab (cycle tabs).

When the Vim toggle is on, an **app-wide Vim layer** (`vimDispatch`, a capture-phase keydown
handler) gives the shell modal control: `appFocus`/`treeCursor` state drives a keyboard cursor over
the file tree (`flatVisibleNodes` for j/k order), sidebar motions
(`j/k/h/l/Enter/gg/G/o/r/dd`) reuse `openFile`/`toggleFolder`/`newNote`/`startRename`/`trashNode`,
`Space` opens a leader which-key menu (`showLeaderMenu`), and `gt/gT` (when the editor isn't focused)
cycle tabs via `cycleTab`. (Pane splits/focus are **not** here — they live in `muxDispatch`, which
works with Vim off too; see above.) It yields entirely when `activePane.getVimMode()` is
`"insert"`, and multi-key sequences (`g _`, `dd`) use a `pendingKey` + timeout. All of
it is gated on `vimEnabled`; `setVimEnabled` fans the flag out to every pane and tears down the
cursor/focus ring.

**Frontend `editor.ts`** — each pane creates one CodeMirror 6 `EditorView`, multiplexed across its
tabs behind the
`EditorHandle` interface
(`openDoc`/`closeDoc`/`renameDoc`/`clear`/`getDoc`/`focus`/`setVim`/`getVimMode`/`destroy`).
Each open tab keeps its own retained `EditorState` (doc + selection + undo history) and scroll
offset in `Map`s keyed by file path; switching tabs stashes the current state and swaps the stored
one in (or builds a fresh one) without firing `onChange`. All states share one extensions array so
every tab behaves identically. **Vim mode** (`@replit/codemirror-vim`) sits in a `Compartment` as
the first extension; `setVim` reconfigures it live, and `swap()` re-asserts the current flag on each
tab switch so retained states stay consistent. `createEditor` takes a `hooks` object whose
`onSave`/`onCloseTab` back the `:w`/`:q`/`:wq` ex-commands (`Vim.defineEx`); auto-save runs
regardless. This is the most intricate file. Three custom pieces layer on top of CodeMirror:
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

`main.ts` is the workspace controller: user action → `vault.ts` invoke → mutate state → re-render,
delegating per-tab/per-editor work to the active `Pane`. The editor never touches the filesystem; it
emits doc changes via `onChange`, which the **pane** debounces into `writeFile` for its active tab.
When switching tabs a pane flushes the prior tab's pending save first (`flushSave`); the editor
suppresses `onChange` during the state swap so the load never registers as an edit. Moving/renaming
a file fans a `remap` out to **all** panes (each remaps its tab paths — including children of a
moved folder — and calls `editor.renameDoc` so retained state follows); trashing uses `forgetTabs`
to drop doomed tabs without saving. `currentFile`/`tabs` in `main.ts` are read-only mirrors kept in
sync by `syncActivePane` for the status bar, search, and Vim layer.

## Conventions & gotchas

- **Path handling is POSIX-only** (`dirname`/`basename`/`relativeToVault` in `paths.ts` split on
  `/`). The app targets macOS/Linux; Windows paths are not handled.
- **`dragDropEnabled: false`** in `tauri.conf.json` is intentional — Tauri's native file drag-drop
  otherwise swallows HTML5 drag events the sidebar relies on for moving files.
- **macOS overlay titlebar.** `apply_overlay_titlebar` (in `main.rs`, run from `setup`) puts the
  window in full-size-content mode with a hidden title so the HTML top bar shares the row with the
  native traffic-light buttons. `main.ts` adds a `pl-20` inset to `#titlebar` only on macOS to clear
  those buttons. The top bar carries `data-tauri-drag-region` so empty areas drag the window (tab
  strips now live inside each pane, not the top bar); there are no custom min/close buttons — the
  native traffic lights handle that. The window
  `minWidth`/`minHeight` are intentionally small (200×200).
- **Tailwind uses semantic color tokens** (`bg`, `fg`, `panel`, `border`, `muted`, `accent`)
  defined in `tailwind.config.js`, not raw colors. Use those tokens for consistency with the
  dark theme.
- **Performance is a product goal.** The release profile in `src-tauri/Cargo.toml` is tuned for
  size (`opt-level="s"`, `lto`, `panic="abort"`, `strip`), Vite targets a lean bundle, and
  CodeMirror language grammars are lazy-loaded. Prefer solutions that keep the footprint small.
- The frontend deliberately avoids any UI framework. Match the existing imperative-DOM style when
  extending the sidebar or modals.
