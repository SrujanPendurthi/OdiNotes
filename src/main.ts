import "./style.css";
import { Fzf, type FzfResultItem } from "fzf";
import { createEditor, type EditorHandle } from "./editor";
import {
  type FileNode,
  pickVault,
  listTree,
  readFile,
  writeFile,
  createUntitled,
  createDir,
  movePath,
  renamePath,
  trashPath,
} from "./vault";

const STORAGE_KEY = "odinotes.vault";
const VIM_KEY = "odinotes.vim";
const SIDEBAR_KEY = "odinotes.sidebarCollapsed";
const TABS_KEY = "odinotes.tabs";

// ---- App state -------------------------------------------------------------
let vaultPath: string | null = null;
let currentFile: string | null = null; // path of the active tab (null = none)
let tabs: string[] = []; // ordered paths of open tabs
let activeDir: string | null = null; // where new notes/folders land
let tree: FileNode[] = [];
const collapsed = new Set<string>();
let dragSrcPath: string | null = null; // file/folder being dragged
let renamingPath: string | null = null; // row currently in inline-rename mode
let vimEnabled = localStorage.getItem(VIM_KEY) === "1"; // persisted Vim toggle
let appFocus: "editor" | "sidebar" = "editor"; // which pane Vim keys drive
let treeCursor: string | null = null; // path of the keyboard-highlighted row

let editor: EditorHandle;
let saveTimer: number | undefined;

// ---- Element lookups -------------------------------------------------------
const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const treeEl = $("tree");
const searchEl = $<HTMLInputElement>("search");
const searchResultsEl = $("search-results");
const emptyStateEl = $("empty-state");
const statusPathEl = $("status-path");
const statusSaveEl = $("status-save");
const btnNewFile = $<HTMLButtonElement>("btn-new-file");
const btnNewFolder = $<HTMLButtonElement>("btn-new-folder");
const btnOpenVault = $<HTMLButtonElement>("btn-open-vault");
const vaultNameEl = $("vault-name");
const btnSettings = $<HTMLButtonElement>("btn-settings");
const tabbarEl = $("tabbar");
const sidebarEl = $("sidebar");
const btnToggleSidebar = $<HTMLButtonElement>("btn-toggle-sidebar");

// On macOS the title bar is drawn as an overlay, so inset the top bar to clear
// the native traffic-light buttons.
if (navigator.userAgent.includes("Macintosh")) {
  $("titlebar").classList.add("pl-20");
}

// ---- Sidebar collapse ------------------------------------------------------
let sidebarCollapsed = false;
function setSidebarCollapsed(collapsed: boolean) {
  sidebarCollapsed = collapsed;
  sidebarEl.classList.toggle("hidden", collapsed);
  localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
}
btnToggleSidebar.addEventListener("click", () =>
  setSidebarCollapsed(!sidebarCollapsed),
);

// ---- Editor wiring ---------------------------------------------------------
editor = createEditor(
  $("editor"),
  (doc) => {
    if (!currentFile) return;
    scheduleSave(doc);
  },
  {
    vimEnabled,
    // `:w` saves the active tab; `:q` closes it; `:wq` is wired in the editor.
    onSave: () => {
      void flushSave().then(() => {
        if (currentFile) statusSaveEl.textContent = "Saved";
      });
    },
    onCloseTab: () => {
      if (currentFile) void closeTab(currentFile);
    },
  },
);

// Flip Vim mode, persist it, and apply it to the live editor.
function setVimEnabled(enabled: boolean) {
  vimEnabled = enabled;
  localStorage.setItem(VIM_KEY, enabled ? "1" : "0");
  editor.setVim(enabled);
  if (!enabled) {
    treeCursor = null;
    setAppFocus("editor"); // drop the focus ring + cursor, return to the editor
  }
}

function scheduleSave(doc: string) {
  statusSaveEl.textContent = "Saving…";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (!currentFile) return;
    try {
      await writeFile(currentFile, doc);
      statusSaveEl.textContent = "Saved";
    } catch (e) {
      statusSaveEl.textContent = `Error: ${e}`;
    }
  }, 400);
}

// ---- Vault / file operations ----------------------------------------------
async function openVault(path: string) {
  // Switching to a *different* vault: save the active tab, then close every
  // open tab and clear the editor so the old vault's files don't linger.
  if (vaultPath && vaultPath !== path) {
    await flushSave();
    forgetTabs(tabs.slice());
  }
  vaultPath = path;
  activeDir = path;
  localStorage.setItem(STORAGE_KEY, path);
  searchEl.disabled = false;
  searchEl.title = path;
  searchEl.placeholder = `Search ${basename(path)}…`;
  btnNewFile.disabled = false;
  btnNewFolder.disabled = false;
  vaultNameEl.textContent = basename(path);
  btnOpenVault.title = path; // full path on hover
  await refreshTree();
  renderTabs(); // reveal the tab bar (and its "+") for the opened vault
}

async function refreshTree() {
  if (!vaultPath) return;
  tree = await listTree(vaultPath);
  renderTree();
  rebuildSearchIndex();
  // Keep an active search in sync with files that were just created/moved.
  if (searchEl.value.trim()) runSearch(searchEl.value);
}

// Flush the active tab's pending save to disk before switching away from it.
async function flushSave() {
  window.clearTimeout(saveTimer);
  if (currentFile) {
    try {
      await writeFile(currentFile, editor.getDoc());
    } catch {
      /* best effort */
    }
  }
}

// Make `path` the active tab and update the chrome around it (or clear the
// editor when `path` is null, i.e. no tabs are open).
function setActive(path: string | null) {
  currentFile = path;
  if (path) {
    activeDir = dirname(path);
    emptyStateEl.classList.add("hidden");
    statusPathEl.textContent = relativeToVault(path);
    statusSaveEl.textContent = "Saved";
    setAppFocus("editor"); // opening a file hands keyboard control to the editor
  } else {
    emptyStateEl.classList.remove("hidden");
    statusPathEl.textContent = "No file open";
    statusSaveEl.textContent = "";
  }
  renderTabs();
  renderTree();
  persistTabs();
}

// Open a note in its own tab: focus it if already open, otherwise append a new
// tab (after the active one) and focus it.
async function openFile(path: string) {
  if (path === currentFile) return;
  if (tabs.includes(path)) return activateTab(path);

  await flushSave();
  const text = await readFile(path);

  const at = currentFile ? tabs.indexOf(currentFile) + 1 : tabs.length;
  tabs.splice(at, 0, path);

  editor.openDoc(path, text);
  setActive(path);
}

// Focus an already-open tab, restoring its retained editor state.
async function activateTab(path: string) {
  if (path === currentFile) return;
  await flushSave();
  editor.openDoc(path, "");
  setActive(path);
}

// Close a tab, falling back to a neighbouring tab (or the empty state).
async function closeTab(path: string) {
  const idx = tabs.indexOf(path);
  if (idx === -1) return;
  if (path === currentFile) await flushSave();

  tabs.splice(idx, 1);
  editor.closeDoc(path);

  if (path !== currentFile) {
    renderTabs();
    persistTabs();
    return;
  }

  const next = tabs[idx] ?? tabs[idx - 1] ?? null;
  if (next) {
    editor.openDoc(next, "");
    setActive(next);
  } else {
    editor.clear();
    setActive(null);
  }
}

// Drop tabs WITHOUT saving — used when their files are being trashed, so a
// pending autosave (or a flush) can't recreate them on disk. `paths` is the
// trashed item plus, for a folder, every open tab beneath it.
function forgetTabs(paths: string[]) {
  const doomed = new Set(paths);
  const oldTabs = tabs.slice();
  const hitCurrent = currentFile !== null && doomed.has(currentFile);
  if (hitCurrent) window.clearTimeout(saveTimer); // cancel the debounced write

  for (const p of paths) {
    if (oldTabs.includes(p)) editor.closeDoc(p);
  }
  tabs = oldTabs.filter((p) => !doomed.has(p));

  if (!hitCurrent) {
    renderTabs();
    persistTabs();
    return;
  }

  // The active tab is gone — fall back to the nearest surviving neighbour.
  const at = oldTabs.indexOf(currentFile!);
  let next: string | null = null;
  for (let i = at + 1; i < oldTabs.length && !next; i++)
    if (!doomed.has(oldTabs[i])) next = oldTabs[i];
  for (let i = at - 1; i >= 0 && !next; i--)
    if (!doomed.has(oldTabs[i])) next = oldTabs[i];

  if (next) {
    editor.openDoc(next, "");
    setActive(next);
  } else {
    editor.clear();
    setActive(null);
  }
}

// Move a file/folder to the vault's hidden Trash and reconcile UI state.
async function trashNode(node: FileNode) {
  if (!vaultPath) return;
  try {
    await trashPath(vaultPath, node.path);
    // Forget the trashed item and, for a folder, any open tab inside it —
    // without flushing, so autosave can't resurrect them at their old paths.
    const prefix = node.path + "/";
    forgetTabs(tabs.filter((p) => p === node.path || p.startsWith(prefix)));
    if (activeDir === node.path || activeDir?.startsWith(prefix)) {
      activeDir = vaultPath;
    }
    await refreshTree();
  } catch (e) {
    alertModal(String(e));
  }
}

// ---- Tab bar rendering -----------------------------------------------------
function renderTabs() {
  tabbarEl.innerHTML = "";
  // Show the tab bar (and its "+" button) whenever a vault is open.
  const show = !!vaultPath;
  tabbarEl.classList.toggle("hidden", !show);
  tabbarEl.classList.toggle("flex", show);
  if (!show) return;

  for (const path of tabs) {
    const active = path === currentFile;
    const tab = document.createElement("div");
    tab.className =
      "group flex h-full min-w-0 max-w-[10rem] shrink-0 cursor-pointer items-center gap-1 border-r border-border px-2 " +
      (active ? "bg-bg text-fg" : "text-muted hover:bg-border/40 hover:text-fg");

    const label = document.createElement("span");
    label.className = "truncate text-[11px]";
    label.textContent = basename(path).replace(/\.md$/i, "");

    const close = document.createElement("button");
    close.title = "Close tab";
    close.className =
      "shrink-0 rounded p-0.5 text-muted hover:bg-border hover:text-fg group-hover:opacity-100 " +
      (active ? "opacity-100" : "opacity-0");
    close.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeTab(path);
    });

    tab.append(label, close);
    tab.addEventListener("click", () => void activateTab(path));
    // Middle-click closes, matching browser tab behaviour.
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        void closeTab(path);
      }
    });
    tabbarEl.appendChild(tab);
  }

  // Trailing "+" — create a new note in a new tab.
  const add = document.createElement("button");
  add.title = "New note";
  add.className =
    "flex shrink-0 items-center justify-center px-2 text-muted hover:bg-border/40 hover:text-fg";
  add.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  add.addEventListener("click", () => void newNote(activeDir ?? vaultPath));
  tabbarEl.appendChild(add);
}

// ---- Tab persistence -------------------------------------------------------
function persistTabs() {
  localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active: currentFile }));
}

// Reopen the tabs from the last session whose files still exist.
async function restoreTabs() {
  const raw = localStorage.getItem(TABS_KEY);
  if (!raw) return;
  let saved: { tabs?: unknown; active?: unknown };
  try {
    saved = JSON.parse(raw);
  } catch {
    return;
  }
  const onDisk = new Set(flattenFiles(tree).map((f) => f.path));
  const valid = Array.isArray(saved.tabs)
    ? (saved.tabs as unknown[]).filter(
        (p): p is string => typeof p === "string" && onDisk.has(p),
      )
    : [];
  if (!valid.length) return;

  for (const p of valid) {
    tabs.push(p);
    editor.openDoc(p, await readFile(p));
  }
  const active =
    typeof saved.active === "string" && valid.includes(saved.active)
      ? saved.active
      : valid[valid.length - 1];
  editor.openDoc(active, "");
  setActive(active);
}

// ---- Sidebar rendering -----------------------------------------------------
function renderTree() {
  treeEl.innerHTML = "";
  treeEl.appendChild(renderNodes(tree, 0));
  if (appFocus === "sidebar") {
    treeEl
      .querySelector<HTMLElement>("[data-cursor]")
      ?.scrollIntoView({ block: "nearest" });
  }
}

function renderNodes(nodes: FileNode[], depth: number): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    frag.appendChild(
      node.is_dir ? renderFolder(node, depth) : renderFileRow(node, depth),
    );
  }
  return frag;
}

function rowBase(depth: number): HTMLDivElement {
  const row = document.createElement("div");
  row.className =
    "group flex items-center gap-1 rounded px-1.5 py-1 cursor-pointer text-fg/90 hover:bg-border/60";
  row.style.paddingLeft = `${depth * 12 + 6}px`;
  return row;
}

function renderFolder(node: FileNode, depth: number): HTMLElement {
  const wrap = document.createElement("div");
  const isCollapsed = collapsed.has(node.path);

  const row = rowBase(depth);
  if (activeDir === node.path) row.classList.add("bg-border/40");
  if (node.path === treeCursor) markCursorRow(row);

  const chevron = document.createElement("span");
  chevron.className = "shrink-0 text-muted transition-transform";
  chevron.style.transform = isCollapsed ? "rotate(-90deg)" : "rotate(0deg)";
  chevron.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  const label = document.createElement("span");
  label.className = "truncate font-medium";
  label.textContent = node.name;

  row.append(chevron, label);
  row.addEventListener("click", () => toggleFolder(node.path));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    activeDir = node.path;
    showContextMenu(e.clientX, e.clientY, node.path, node);
  });

  // A folder can be dragged…
  makeDraggable(row, node.path);

  // …and is a drop target that nests the dragged item inside it.
  row.addEventListener("dragover", (e) => {
    if (!dragSrcPath || dragSrcPath === node.path) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    row.classList.add("ring-1", "ring-accent", "bg-accent/20");
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("ring-1", "ring-accent", "bg-accent/20");
  });
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove("ring-1", "ring-accent", "bg-accent/20");
    void moveInto(dragSrcPath, node.path);
  });

  wrap.appendChild(row);

  if (!isCollapsed && node.children.length) {
    wrap.appendChild(renderNodes(node.children, depth + 1));
  }
  return wrap;
}

function renderFileRow(node: FileNode, depth: number): HTMLElement {
  const row = rowBase(depth);
  if (currentFile === node.path) row.classList.add("bg-accent/20", "text-fg");
  if (node.path === treeCursor) markCursorRow(row);

  const dot = document.createElement("span");
  dot.className = "shrink-0 text-muted";
  dot.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

  // In rename mode this row is just an icon + text input.
  if (node.path === renamingPath) {
    row.append(dot, renameInput(node.path, node.name.replace(/\.md$/i, "")));
    return row;
  }

  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = node.name.replace(/\.md$/i, "");

  row.append(dot, label);
  // Any click opens the file in its own tab (or focuses it if already open).
  row.addEventListener("click", () => {
    void openFile(node.path);
  });
  row.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
      e.preventDefault();
      void openFile(node.path);
    }
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, dirname(node.path), node);
  });
  makeDraggable(row, node.path);
  return row;
}

// ---- Drag & drop (move files / folders) ------------------------------------
function makeDraggable(row: HTMLElement, path: string) {
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    dragSrcPath = path;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", path);
    }
    e.stopPropagation();
  });
  row.addEventListener("dragend", () => {
    dragSrcPath = null;
  });
}

// Reflect a path change (rename or move) of `src` → `newPath` across open tabs,
// the editor's retained per-tab state, the active file, and the new-item target
// dir. Handles a moved/renamed folder by remapping everything beneath it too.
function applyPathChange(src: string, newPath: string) {
  const remap = (p: string): string =>
    p === src
      ? newPath
      : p.startsWith(src + "/")
        ? newPath + p.slice(src.length)
        : p;
  tabs = tabs.map((p) => {
    const np = remap(p);
    if (np !== p) editor.renameDoc(p, np);
    return np;
  });
  if (currentFile) {
    currentFile = remap(currentFile);
    statusPathEl.textContent = relativeToVault(currentFile);
  }
  if (activeDir) activeDir = remap(activeDir);
}

async function moveInto(src: string | null, destDir: string) {
  if (!src) return;
  dragSrcPath = null;
  // No-op when dropping an item back into its current parent.
  if (dirname(src) === destDir) return;

  try {
    const newPath = await movePath(src, destDir);
    applyPathChange(src, newPath);
    renderTabs();
    persistTabs();
    await refreshTree();
  } catch (e) {
    alertModal(String(e));
  }
}

// ---- Inline rename ---------------------------------------------------------
// Put a file/folder row into edit mode. `renderTree` reads `renamingPath`, so
// the input survives the imperative re-renders that other actions trigger.
function startRename(path: string) {
  renamingPath = path;
  renderTree();
}

// Build the edit-mode input for a row. `displayName` is what the user edits
// (basename without ".md" for files, the full name for folders).
function renameInput(path: string, displayName: string): HTMLInputElement {
  const input = document.createElement("input");
  input.className =
    "min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-fg outline-none";
  input.value = displayName;

  let settled = false;
  const finish = (commit: boolean) => {
    if (settled) return; // guard the commit→re-render→blur double-fire
    settled = true;
    const value = input.value.trim();
    renamingPath = null;
    if (commit && value && value !== displayName) {
      void doRename(path, value);
    } else {
      renderTree(); // revert the row to its stored name
    }
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // don't let the row/global shortcuts see these keys
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true)); // Finder-style: commit
  input.addEventListener("click", (e) => e.stopPropagation());
  // Focus + select the name once the row is mounted.
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return input;
}

async function doRename(path: string, newName: string) {
  try {
    const newPath = await renamePath(path, newName);
    applyPathChange(path, newPath);
    renderTabs();
    persistTabs();
    await refreshTree();
  } catch (e) {
    alertModal(String(e));
    await refreshTree(); // restore the row to the real on-disk name
  }
}

// Dropping onto empty file-tree space moves the item to the vault root.
treeEl.addEventListener("dragover", (e) => {
  if (!dragSrcPath || !vaultPath) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
});
treeEl.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!vaultPath) return;
  void moveInto(dragSrcPath, vaultPath);
});

// ---- Fuzzy search (fzf) ----------------------------------------------------
interface SearchItem {
  path: string;
  rel: string; // vault-relative path, ".md" stripped — what we match & show
}

let fzf: Fzf<SearchItem[]> | null = null;
let searchResults: FzfResultItem<SearchItem>[] = [];
let searchSelected = 0;
const SEARCH_LIMIT = 50;

function flattenFiles(nodes: FileNode[], out: SearchItem[] = []): SearchItem[] {
  for (const node of nodes) {
    if (node.is_dir) flattenFiles(node.children, out);
    else
      out.push({
        path: node.path,
        rel: relativeToVault(node.path).replace(/\.md$/i, ""),
      });
  }
  return out;
}

function rebuildSearchIndex() {
  fzf = new Fzf(flattenFiles(tree), { selector: (i) => i.rel });
}

function runSearch(query: string) {
  const q = query.trim();
  if (!q || !fzf) {
    showTree();
    return;
  }
  searchResults = fzf.find(q).slice(0, SEARCH_LIMIT);
  searchSelected = 0;
  renderSearchResults();
  showSearchResults();
}

function showTree() {
  searchResults = [];
  searchResultsEl.classList.add("hidden");
  treeEl.classList.remove("hidden");
}

function showSearchResults() {
  treeEl.classList.add("hidden");
  searchResultsEl.classList.remove("hidden");
}

// Wrap fuzzy-matched characters so they stand out in the result row.
function highlightMatch(text: string, positions: Set<number>): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < text.length; i++) {
    if (positions.has(i)) {
      const mark = document.createElement("span");
      mark.className = "text-accent font-semibold";
      mark.textContent = text[i];
      frag.appendChild(mark);
    } else {
      frag.appendChild(document.createTextNode(text[i]));
    }
  }
  return frag;
}

function renderSearchResults() {
  searchResultsEl.innerHTML = "";

  if (!searchResults.length) {
    const empty = document.createElement("div");
    empty.className = "px-2 py-2 text-xs text-muted";
    empty.textContent = "No matches";
    searchResultsEl.appendChild(empty);
    return;
  }

  searchResults.forEach((res, idx) => {
    const row = document.createElement("div");
    row.className = "flex items-center gap-1 rounded px-1.5 py-1 cursor-pointer text-fg/90 hover:bg-border/60";
    row.dataset.idx = String(idx);

    const dot = document.createElement("span");
    dot.className = "shrink-0 text-muted";
    dot.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

    const label = document.createElement("span");
    label.className = "truncate";
    label.appendChild(highlightMatch(res.item.rel, res.positions));

    row.append(dot, label);
    row.addEventListener("click", () => selectResult(idx));
    searchResultsEl.appendChild(row);
  });

  highlightSelected();
}

function highlightSelected() {
  const rows = searchResultsEl.querySelectorAll<HTMLElement>("[data-idx]");
  rows.forEach((row, idx) => {
    row.classList.toggle("bg-accent/20", idx === searchSelected);
    row.classList.toggle("text-fg", idx === searchSelected);
  });
}

function moveSelection(delta: number) {
  if (!searchResults.length) return;
  searchSelected =
    (searchSelected + delta + searchResults.length) % searchResults.length;
  highlightSelected();
  searchResultsEl
    .querySelector(`[data-idx="${searchSelected}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

function selectResult(idx: number) {
  const item = searchResults[idx]?.item;
  if (!item) return;
  clearSearch();
  void openFile(item.path);
}

function clearSearch() {
  searchEl.value = "";
  showTree();
}

searchEl.addEventListener("input", () => runSearch(searchEl.value));
searchEl.addEventListener("keydown", (e) => {
  // Vim-style result navigation: Ctrl-j/Ctrl-n down, Ctrl-k/Ctrl-p up.
  if (vimEnabled && e.ctrlKey) {
    if (e.key === "j" || e.key === "n") {
      e.preventDefault();
      return moveSelection(1);
    }
    if (e.key === "k" || e.key === "p") {
      e.preventDefault();
      return moveSelection(-1);
    }
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      moveSelection(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      moveSelection(-1);
      break;
    case "Enter":
      e.preventDefault();
      if (searchResults.length) selectResult(searchSelected);
      break;
    case "Escape":
      e.preventDefault();
      searchEl.value ? clearSearch() : searchEl.blur();
      break;
  }
});

// ---- Create note / folder --------------------------------------------------
async function newNote(dir: string | null) {
  if (!dir) return;
  try {
    const path = await createUntitled(dir);
    await refreshTree();
    await openFile(path);
    startRename(path); // drop straight into inline rename of the new note
  } catch (e) {
    alertModal(String(e));
  }
}

async function newFolder(parent: string | null) {
  if (!parent) return;
  const name = await promptModal("New folder", "");
  if (!name) return;
  try {
    await createDir(parent, name);
    await refreshTree();
  } catch (e) {
    alertModal(String(e));
  }
}

btnNewFile.addEventListener("click", () => newNote(activeDir ?? vaultPath));
btnNewFolder.addEventListener("click", () => newFolder(activeDir ?? vaultPath));

btnOpenVault.addEventListener("click", async () => {
  const path = await pickVault();
  if (path) await openVault(path);
});

// ---- Minimal modal (Tauri webviews don't support window.prompt) ------------
function promptModal(
  title: string,
  placeholder: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-50 flex items-center justify-center bg-black/50";

    const box = document.createElement("div");
    box.className =
      "w-72 rounded-lg border border-border bg-panel p-4 shadow-xl";
    box.innerHTML = `<p class="mb-2 text-sm font-semibold text-fg">${title}</p>`;

    const input = document.createElement("input");
    input.placeholder = placeholder;
    input.className =
      "mb-3 w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent";

    const actions = document.createElement("div");
    actions.className = "flex justify-end gap-2";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.className = "rounded px-3 py-1 text-xs text-muted hover:text-fg";
    const ok = document.createElement("button");
    ok.textContent = "Create";
    ok.className =
      "rounded bg-accent px-3 py-1 text-xs font-medium text-bg hover:opacity-90";

    actions.append(cancel, ok);
    box.append(input, actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();

    const close = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };
    const submit = () => close(input.value.trim() || null);

    ok.addEventListener("click", submit);
    cancel.addEventListener("click", () => close(null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") close(null);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
  });
}

function alertModal(message: string) {
  statusSaveEl.textContent = message;
  window.setTimeout(() => {
    if (statusSaveEl.textContent === message) statusSaveEl.textContent = "";
  }, 4000);
}

// ---- Right-click context menu ---------------------------------------------
// Suppress the native webview menu (Inspect / Reload) everywhere…
document.addEventListener("contextmenu", (e) => e.preventDefault());

// …and offer our own when right-clicking empty file-tree space (→ vault root).
treeEl.addEventListener("contextmenu", (e) => {
  if (!vaultPath) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, vaultPath);
});

let openMenu: HTMLElement | null = null;
let dismissHandler: ((e: Event) => void) | null = null;

function closeContextMenu() {
  if (dismissHandler) {
    document.removeEventListener("pointerdown", dismissHandler, true);
    dismissHandler = null;
  }
  openMenu?.remove();
  openMenu = null;
}

function showContextMenu(x: number, y: number, dir: string, node?: FileNode) {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className =
    "fixed z-50 min-w-44 overflow-hidden rounded-md border border-border bg-panel py-1 text-sm shadow-xl";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const item = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className =
      "flex w-full items-center px-3 py-1.5 text-left text-fg/90 hover:bg-accent hover:text-bg";
    b.textContent = label;
    b.addEventListener("click", () => {
      closeContextMenu();
      onClick();
    });
    return b;
  };

  menu.append(
    item("New note", () => newNote(dir)),
    item("New folder", () => newFolder(dir)),
  );

  // Rename/Delete are only offered when right-clicking an actual file/folder row.
  if (node) {
    const sep = document.createElement("div");
    sep.className = "my-1 border-t border-border";
    menu.append(sep);
    if (!node.is_dir) menu.append(item("Rename", () => startRename(node.path)));
    menu.append(item("Delete", () => void trashNode(node)));
  }

  mountMenu(menu, x, y);
}

// Place a built menu at (x, y), nudge it back on-screen near a right/bottom
// edge, and wire dismissal on the next outside press.
function mountMenu(menu: HTMLElement, x: number, y: number) {
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  openMenu = menu;

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;

  // Close only on a *new* press outside the menu. Deferring the binding past
  // this event loop tick keeps the opening click from closing it instantly.
  dismissHandler = (e: Event) => {
    if (openMenu && !openMenu.contains(e.target as Node)) closeContextMenu();
  };
  setTimeout(() => {
    if (dismissHandler) {
      document.addEventListener("pointerdown", dismissHandler, true);
    }
  }, 0);
}

// ---- Settings menu ---------------------------------------------------------
function showSettingsMenu(x: number, y: number) {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className =
    "fixed z-50 min-w-44 overflow-hidden rounded-md border border-border bg-panel py-1 text-sm shadow-xl";

  // A toggle row: label on the left, a ✓ when on. Stays open so multiple
  // settings can be flipped before dismissing.
  const toggle = (
    label: string,
    get: () => boolean,
    set: (v: boolean) => void,
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className =
      "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-fg/90 hover:bg-accent hover:text-bg";
    const text = document.createElement("span");
    text.textContent = label;
    const check = document.createElement("span");
    check.className = "shrink-0";
    check.textContent = get() ? "✓" : "";
    b.append(text, check);
    b.addEventListener("click", () => {
      set(!get());
      check.textContent = get() ? "✓" : "";
    });
    return b;
  };

  menu.append(toggle("Vim mode", () => vimEnabled, setVimEnabled));
  mountMenu(menu, x, y);
}

btnSettings.addEventListener("click", () => {
  const r = btnSettings.getBoundingClientRect();
  showSettingsMenu(r.left, r.top); // edge-nudge floats it above the gear
});

// Also dismiss on Escape or window resize.
window.addEventListener("resize", closeContextMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeContextMenu();
  // ⌘/Ctrl+K jumps to the search bar.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !searchEl.disabled) {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
  }
  // ⌘/Ctrl+W closes the active tab.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w" && currentFile) {
    e.preventDefault();
    void closeTab(currentFile);
  }
  // Ctrl+Tab / Ctrl+Shift+Tab cycle through open tabs.
  if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
  }
});

// ---- App-wide Vim (gated on the Vim toggle) --------------------------------
// A capture-phase dispatcher gives the shell modal keyboard control: pane focus
// switching, sidebar tree navigation, a leader menu, and tab motions. It
// coordinates with the editor via `editor.getVimMode()` so it never steals keys
// while the user is typing in insert mode.

function markCursorRow(row: HTMLElement) {
  row.classList.add("ring-1", "ring-inset", "ring-accent");
  row.dataset.cursor = "1";
}

// Flatten the tree to the rows currently visible (collapsed folders excluded),
// in render order — the sequence j/k step through.
function flatVisibleNodes(nodes: FileNode[] = tree, out: FileNode[] = []): FileNode[] {
  for (const node of nodes) {
    out.push(node);
    if (node.is_dir && !collapsed.has(node.path) && node.children.length) {
      flatVisibleNodes(node.children, out);
    }
  }
  return out;
}

function cursorNode(): FileNode | null {
  return flatVisibleNodes().find((n) => n.path === treeCursor) ?? null;
}

// Directory new notes/folders land in for the current cursor row.
function cursorDir(): string | null {
  const node = cursorNode();
  if (!node) return activeDir ?? vaultPath;
  return node.is_dir ? node.path : dirname(node.path);
}

function setAppFocus(target: "editor" | "sidebar") {
  appFocus = target;
  if (target === "sidebar") {
    const nodes = flatVisibleNodes();
    if (!treeCursor || !nodes.some((n) => n.path === treeCursor)) {
      treeCursor = currentFile ?? nodes[0]?.path ?? null;
    }
    (document.activeElement as HTMLElement | null)?.blur?.();
    sidebarEl.classList.add("ring-1", "ring-inset", "ring-accent/40");
  } else {
    sidebarEl.classList.remove("ring-1", "ring-inset", "ring-accent/40");
    if (currentFile) editor.focus();
  }
  renderTree();
}

function moveTreeCursor(delta: number) {
  const nodes = flatVisibleNodes();
  if (!nodes.length) return;
  const i = nodes.findIndex((n) => n.path === treeCursor);
  const next = i === -1 ? 0 : Math.max(0, Math.min(nodes.length - 1, i + delta));
  treeCursor = nodes[next].path;
  renderTree();
}

function setTreeCursorEnd(end: "first" | "last") {
  const nodes = flatVisibleNodes();
  if (!nodes.length) return;
  treeCursor = (end === "first" ? nodes[0] : nodes[nodes.length - 1]).path;
  renderTree();
}

function toggleFolder(path: string) {
  if (collapsed.has(path)) collapsed.delete(path);
  else collapsed.add(path);
  activeDir = path;
  renderTree();
}

// `l` / Enter: open a file (and hand focus to the editor) or expand a folder.
function treeOpen() {
  const node = cursorNode();
  if (!node) return;
  if (node.is_dir) {
    if (collapsed.has(node.path)) {
      collapsed.delete(node.path);
      activeDir = node.path;
      renderTree();
    } else {
      moveTreeCursor(1); // already open — step into the first child
    }
  } else {
    void openFile(node.path);
  }
}

// `h`: collapse an open folder, else jump to the parent directory row.
function treeCollapseOrParent() {
  const node = cursorNode();
  if (!node) return;
  if (node.is_dir && !collapsed.has(node.path)) {
    collapsed.add(node.path);
    renderTree();
    return;
  }
  const parent = dirname(node.path);
  if (flatVisibleNodes().some((n) => n.path === parent)) {
    treeCursor = parent;
    renderTree();
  }
}

function cycleTab(dir: number) {
  if (tabs.length < 2) return;
  const i = currentFile ? tabs.indexOf(currentFile) : 0;
  const next = tabs[(i + dir + tabs.length) % tabs.length];
  void activateTab(next);
}

// Leader (Space) which-key menu: keyboard-driven app actions.
function showLeaderMenu() {
  closeContextMenu();
  const entries: { key: string; label: string; run: () => void }[] = [
    {
      key: "f",
      label: "Find file",
      run: () => {
        searchEl.focus();
        searchEl.select();
      },
    },
    { key: "e", label: "Focus explorer", run: () => setAppFocus("sidebar") },
    { key: "n", label: "New note", run: () => void newNote(cursorDir()) },
    {
      key: "N",
      label: "New folder",
      run: () => void newFolder(activeDir ?? vaultPath),
    },
    {
      key: "o",
      label: "Open vault…",
      run: () => {
        void pickVault().then((p) => {
          if (p) void openVault(p);
        });
      },
    },
    { key: "w", label: "Save", run: () => void flushSave() },
    {
      key: "x",
      label: "Close tab",
      run: () => {
        if (currentFile) void closeTab(currentFile);
      },
    },
    {
      key: "b",
      label: "Toggle sidebar",
      run: () => setSidebarCollapsed(!sidebarCollapsed),
    },
    {
      key: "s",
      label: "Settings",
      run: () => {
        const r = btnSettings.getBoundingClientRect();
        showSettingsMenu(r.left, r.top);
      },
    },
  ];

  const menu = document.createElement("div");
  menu.className =
    "fixed z-50 min-w-56 overflow-hidden rounded-md border border-border bg-panel py-1 text-sm shadow-xl";
  for (const ent of entries) {
    const b = document.createElement("button");
    b.className =
      "flex w-full items-center gap-3 px-3 py-1.5 text-left text-fg/90 hover:bg-accent hover:text-bg";
    const key = document.createElement("kbd");
    key.className =
      "w-5 shrink-0 rounded bg-border/70 text-center text-xs font-mono text-fg";
    key.textContent = ent.key;
    const label = document.createElement("span");
    label.textContent = ent.label;
    b.append(key, label);
    b.addEventListener("click", () => {
      closeLeader();
      ent.run();
    });
    menu.append(b);
  }

  mountMenu(
    menu,
    window.innerWidth / 2 - 112,
    Math.max(60, window.innerHeight / 2 - 140),
  );

  const onKey = (e: KeyboardEvent) => {
    if (!openMenu) return closeLeader(); // closed by an outside press
    if (e.key === "Escape") {
      e.preventDefault();
      return closeLeader();
    }
    const ent = entries.find((x) => x.key === e.key);
    if (ent) {
      e.preventDefault();
      e.stopPropagation();
      closeLeader();
      ent.run();
    }
  };
  const closeLeader = () => {
    document.removeEventListener("keydown", onKey, true);
    closeContextMenu();
  };
  document.addEventListener("keydown", onKey, true);
}

let pendingKey: string | null = null;
let pendingTimer: number | undefined;
function setPending(k: string | null) {
  pendingKey = k;
  window.clearTimeout(pendingTimer);
  if (k) pendingTimer = window.setTimeout(() => (pendingKey = null), 600);
}

function vimDispatch(e: KeyboardEvent) {
  if (!vimEnabled) return;
  const ae = document.activeElement as HTMLElement | null;
  // Text inputs (search, inline rename, prompt modal) own their own keys.
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
  if (openMenu) return; // an open menu handles keys itself
  // Ignore bare modifier presses so they don't disturb a pending sequence.
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;

  const editorFocused = !!ae && $("editor").contains(ae);
  if (editorFocused && editor.getVimMode() === "insert") return; // typing

  // ---- resolve a pending multi-key sequence ----
  if (pendingKey === "ctrl-w") {
    setPending(null);
    if (e.key === "h" || e.key === "l" || e.key === "w") {
      e.preventDefault();
      setAppFocus(e.key === "l" ? "editor" : "sidebar");
    }
    return;
  }
  if (pendingKey === "g") {
    setPending(null);
    if (e.key === "t" || e.key === "T") {
      e.preventDefault();
      cycleTab(e.key === "t" ? 1 : -1);
    } else if (e.key === "g" && appFocus === "sidebar") {
      e.preventDefault();
      setTreeCursorEnd("first");
    }
    return;
  }
  if (pendingKey === "d") {
    setPending(null);
    if (e.key === "d" && appFocus === "sidebar") {
      e.preventDefault();
      const node = cursorNode();
      if (node) void trashNode(node);
    }
    return;
  }

  // ---- start of a sequence / single global keys ----
  if (e.ctrlKey && e.key.toLowerCase() === "w") {
    e.preventDefault();
    setPending("ctrl-w");
    return;
  }
  if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    showLeaderMenu();
    return;
  }
  // gt/gT work whenever the editor isn't focused (so it keeps its own `g`).
  if (e.key === "g" && !editorFocused && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    setPending("g");
    return;
  }

  if (editorFocused) return; // editor (normal/visual) handles the rest itself

  // ---- sidebar context: bare-key motions ----
  if (appFocus !== "sidebar" || e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case "j": e.preventDefault(); moveTreeCursor(1); break;
    case "k": e.preventDefault(); moveTreeCursor(-1); break;
    case "l":
    case "Enter": e.preventDefault(); treeOpen(); break;
    case "h": e.preventDefault(); treeCollapseOrParent(); break;
    case "G": e.preventDefault(); setTreeCursorEnd("last"); break;
    case "d": e.preventDefault(); setPending("d"); break;
    case "o":
    case "a": e.preventDefault(); void newNote(cursorDir()); break;
    case "r": {
      e.preventDefault();
      const n = cursorNode();
      if (n && !n.is_dir) startRename(n.path);
      break;
    }
    case "Escape": e.preventDefault(); setAppFocus("editor"); break;
  }
}

document.addEventListener("keydown", vimDispatch, true);

// ---- Path helpers (work for POSIX paths on macOS/Linux) --------------------
function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}
function dirname(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  parts.pop();
  return parts.join("/");
}
function relativeToVault(p: string): string {
  if (vaultPath && p.startsWith(vaultPath)) {
    return p.slice(vaultPath.length).replace(/^\/+/, "");
  }
  return p;
}

// ---- Boot ------------------------------------------------------------------
(async function init() {
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      await openVault(saved);
      await restoreTabs();
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
})();
