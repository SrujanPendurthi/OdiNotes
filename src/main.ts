import "./style.css";
import { Fzf, type FzfResultItem } from "fzf";
import { Pane } from "./pane";
import { basename, dirname, relativeToVault } from "./paths";
import {
  type FileNode,
  pickVault,
  listTree,
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
let activeDir: string | null = null; // where new notes/folders land
let tree: FileNode[] = [];
const collapsed = new Set<string>();
let dragSrcPath: string | null = null; // file/folder being dragged
let renamingPath: string | null = null; // row currently in inline-rename mode
let vimEnabled = localStorage.getItem(VIM_KEY) === "1"; // persisted Vim toggle
let appFocus: "editor" | "sidebar" = "editor"; // sidebar vs the pane area
let treeCursor: string | null = null; // path of the keyboard-highlighted row

// The editor area is a binary tree of panes (tmux-style splits). `currentFile`/
// `tabs` mirror the *active* pane so the many read-sites (status bar, sidebar
// highlight, Vim dispatch) keep working; all mutations go through Pane methods.
type PNode =
  | { kind: "leaf"; pane: Pane }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: PNode; b: PNode };
let root: PNode | null = null;
let activePane: Pane | null = null;
let currentFile: string | null = null; // mirror: active pane's active tab
let tabs: string[] = []; // mirror: active pane's open tabs

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
const editorWrapEl = $("editor-wrap");
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

// ---- Pane management -------------------------------------------------------
// Build the (currently single) pane and mount it into the editor area.
function createPane(): Pane {
  const p = new Pane({
    vimEnabled,
    onActivate: setActivePane,
    onActiveChange: syncActivePane,
    onNewNote: (pn) => {
      setActivePane(pn);
      void newNote(activeDir ?? vaultPath);
    },
    onSaveStatus: (pn, text) => {
      if (pn === activePane) statusSaveEl.textContent = text;
    },
    onSplit: (pn, dir) => splitActive(dir, pn),
    onClosePane: (pn) => void closePane(pn),
  });
  return p;
}

// Every open leaf pane, left-to-right / top-to-bottom.
function allPanes(): Pane[] {
  const out: Pane[] = [];
  const walk = (n: PNode | null) => {
    if (!n) return;
    if (n.kind === "leaf") out.push(n.pane);
    else {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(root);
  return out;
}

// Make `p` the focused pane and refresh the global mirror around it.
function setActivePane(p: Pane) {
  if (activePane === p) return;
  activePane?.setActiveRing(false);
  activePane = p;
  p.setActiveRing(true);
  appFocus = "editor";
  sidebarEl.classList.remove("ring-1", "ring-inset", "ring-accent/40");
  syncActivePane(p);
}

// Mirror the active pane's tab state into the globals the rest of the app reads.
function syncActivePane(p: Pane) {
  if (p !== activePane) return;
  currentFile = p.activeTab;
  tabs = p.tabs;
  if (currentFile) {
    activeDir = dirname(currentFile);
    statusPathEl.textContent = relativeToVault(currentFile, vaultPath);
    statusSaveEl.textContent = "Saved";
  } else {
    statusPathEl.textContent = "No file open";
    statusSaveEl.textContent = "";
  }
  persistLayout();
  renderTree();
}

// Flip Vim mode, persist it, and apply it across every pane's editor.
function setVimEnabled(enabled: boolean) {
  vimEnabled = enabled;
  localStorage.setItem(VIM_KEY, enabled ? "1" : "0");
  for (const p of allPanes()) p.setVim(enabled);
  if (!enabled) {
    treeCursor = null;
    setAppFocus("editor"); // drop the focus ring + cursor, return to the editor
  }
}

// ---- Vault / file operations ----------------------------------------------
async function openVault(path: string) {
  // Switching to a *different* vault: save and clear every pane first.
  if (vaultPath && vaultPath !== path) {
    for (const p of allPanes()) {
      await p.flushSave();
      p.forgetTabs(p.tabs.slice());
    }
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
  ensurePane();
  await refreshTree();
}

// Create the root pane on first vault open and mount it into the editor area.
function ensurePane() {
  if (root) return;
  const p = createPane();
  root = { kind: "leaf", pane: p };
  emptyStateEl.classList.add("hidden");
  renderPanes();
  setActivePane(p);
}

// ---- Pane tree layout ------------------------------------------------------
// Rebuild #editor-wrap from the tree. Pane DOM nodes are reused (moved), so the
// live CodeMirror views survive a relayout.
function renderPanes() {
  const panes = allPanes();
  for (const p of panes) {
    p.el.style.flex = ""; // reset stale flex bases
    p.setCanClose(panes.length > 1); // close-pane button only when splittable
  }
  editorWrapEl.querySelectorAll(":scope > [data-split], :scope > [data-pane-id]")
    .forEach((e) => e.remove());
  if (root) editorWrapEl.appendChild(buildNode(root));
}

function buildNode(node: PNode): HTMLElement {
  if (node.kind === "leaf") return node.pane.el;
  const box = document.createElement("div");
  box.dataset.split = "1";
  box.className = `flex min-h-0 min-w-0 flex-1 ${node.dir === "row" ? "flex-row" : "flex-col"}`;
  const a = buildNode(node.a);
  const b = buildNode(node.b);
  a.style.flex = `${node.ratio} 1 0`;
  b.style.flex = `${1 - node.ratio} 1 0`;
  const divider = document.createElement("div");
  divider.className =
    node.dir === "row"
      ? "w-px shrink-0 cursor-col-resize bg-border hover:bg-accent"
      : "h-px shrink-0 cursor-row-resize bg-border hover:bg-accent";
  divider.addEventListener("pointerdown", (e) => startResize(e, node, box, a, b));
  box.append(a, divider, b);
  return box;
}

// Drag a divider: update the split ratio live by adjusting flex bases directly
// (no relayout, so editors aren't disturbed).
function startResize(
  e: PointerEvent,
  split: Extract<PNode, { kind: "split" }>,
  box: HTMLElement,
  a: HTMLElement,
  b: HTMLElement,
) {
  e.preventDefault();
  const onMove = (ev: PointerEvent) => {
    const r = box.getBoundingClientRect();
    const ratio =
      split.dir === "row"
        ? (ev.clientX - r.left) / r.width
        : (ev.clientY - r.top) / r.height;
    split.ratio = Math.min(0.85, Math.max(0.15, ratio));
    a.style.flex = `${split.ratio} 1 0`;
    b.style.flex = `${1 - split.ratio} 1 0`;
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    persistLayout();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// ---- Pane focus / split / close --------------------------------------------
function focusPane(p: Pane | null) {
  if (!p) return;
  setActivePane(p);
  p.focus();
}

// Split a pane (the active one by default); the new pane opens the same file
// (vim :sp behaviour).
function splitActive(dir: "row" | "col", target: Pane | null = activePane) {
  if (!root || !target) return;
  const oldPane = target;
  const file = oldPane.activeTab;
  const newPane = createPane();
  root = replaceLeaf(root, oldPane, {
    kind: "split",
    dir,
    ratio: 0.5,
    a: { kind: "leaf", pane: oldPane },
    b: { kind: "leaf", pane: newPane },
  });
  renderPanes();
  setActivePane(newPane);
  if (file) void newPane.openFile(file);
  newPane.focus();
  persistLayout();
}

function replaceLeaf(node: PNode, target: Pane, repl: PNode): PNode {
  if (node.kind === "leaf") return node.pane === target ? repl : node;
  return {
    ...node,
    a: replaceLeaf(node.a, target, repl),
    b: replaceLeaf(node.b, target, repl),
  };
}

// Remove `target`'s leaf; its sibling collapses into the parent's slot.
function removeLeaf(node: PNode, target: Pane): PNode | null {
  if (node.kind === "leaf") return node.pane === target ? null : node;
  const a = removeLeaf(node.a, target);
  const b = removeLeaf(node.b, target);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

// Close a pane (the active one by default); its sibling reclaims the space.
async function closePane(target: Pane | null = activePane) {
  if (!root || !target || root.kind === "leaf") return; // keep ≥1 pane
  const removed = target;
  await removed.flushSave();
  root = removeLeaf(root, removed);
  removed.destroy();
  renderPanes();
  focusPane(allPanes()[0]);
  persistLayout();
}

function cyclePane() {
  const panes = allPanes();
  if (panes.length < 2) return;
  const i = activePane ? panes.indexOf(activePane) : 0;
  focusPane(panes[(i + 1) % panes.length]);
}

// Move focus to the nearest pane in a direction; off the left edge → sidebar.
function focusDir(key: "h" | "j" | "k" | "l") {
  if (appFocus === "sidebar") {
    if (key === "l") focusPane(activePane ?? allPanes()[0]);
    return;
  }
  const next = paneInDirection(activePane, key);
  if (next) focusPane(next);
  else if (key === "h") setAppFocus("sidebar");
}

function paneInDirection(from: Pane | null, key: "h" | "j" | "k" | "l"): Pane | null {
  if (!from) return null;
  const r = from.el.getBoundingClientRect();
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;
  let best: Pane | null = null;
  let bestDist = Infinity;
  for (const p of allPanes()) {
    if (p === from) continue;
    const pr = p.el.getBoundingClientRect();
    const dx = (pr.left + pr.right) / 2 - cx;
    const dy = (pr.top + pr.bottom) / 2 - cy;
    const ok =
      key === "h"
        ? dx < -1 && Math.abs(dy) <= Math.abs(dx)
        : key === "l"
          ? dx > 1 && Math.abs(dy) <= Math.abs(dx)
          : key === "k"
            ? dy < -1 && Math.abs(dx) <= Math.abs(dy)
            : dy > 1 && Math.abs(dx) <= Math.abs(dy);
    if (!ok) continue;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

async function refreshTree() {
  if (!vaultPath) return;
  tree = await listTree(vaultPath);
  renderTree();
  rebuildSearchIndex();
  // Keep an active search in sync with files that were just created/moved.
  if (searchEl.value.trim()) runSearch(searchEl.value);
}

// Flush the active pane's pending save (used by `:w` / leader save).
async function flushSave() {
  await activePane?.flushSave();
}

// Thin delegators — callers across the app open/activate/close through the
// focused pane, which owns the real tab + editor state.
function openFile(path: string): Promise<void> | undefined {
  return activePane?.openFile(path);
}
function activateTab(path: string): Promise<void> | undefined {
  return activePane?.activateTab(path);
}
function closeTab(path: string): Promise<void> | undefined {
  return activePane?.closeTab(path);
}

// Move a file/folder to the vault's hidden Trash and reconcile UI state.
async function trashNode(node: FileNode) {
  if (!vaultPath) return;
  try {
    await trashPath(vaultPath, node.path);
    // Forget the trashed item (and a folder's children) in *every* pane —
    // without flushing, so autosave can't resurrect them at their old paths.
    const prefix = node.path + "/";
    const hit = (p: string) => p === node.path || p.startsWith(prefix);
    for (const pn of allPanes()) pn.forgetTabs(pn.tabs.filter(hit));
    if (activeDir === node.path || activeDir?.startsWith(prefix)) {
      activeDir = vaultPath;
    }
    await refreshTree();
  } catch (e) {
    alertModal(String(e));
  }
}

// ---- Layout persistence ----------------------------------------------------
// NOTE: only the active pane's tabs persist for now; restoring the full split
// tree across restarts is Phase 3.
function persistLayout() {
  if (!activePane) return;
  const s = activePane.serialize();
  localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: s.tabs, active: s.active }));
}

// Reopen the tabs from the last session whose files still exist. `raw` is
// captured before `openVault` mounts the pane (which would overwrite the key).
async function restoreLayout(raw: string | null) {
  const p = allPanes()[0];
  if (!raw || !p) return;
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
  const active =
    typeof saved.active === "string" && valid.includes(saved.active)
      ? saved.active
      : valid[valid.length - 1];
  await p.restore(valid, active);
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
  for (const p of allPanes()) p.remap(remap);
  if (currentFile) {
    currentFile = remap(currentFile);
    statusPathEl.textContent = relativeToVault(currentFile, vaultPath);
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
    persistLayout();
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
    persistLayout();
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
        rel: relativeToVault(node.path, vaultPath).replace(/\.md$/i, ""),
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
    activePane?.focus();
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

  // "Editor focused" = caret is inside some pane's CodeMirror, not a tab strip.
  // (The pane/split prefix lives in `muxDispatch`, which runs before this and is
  // independent of Vim mode.)
  const editorFocused = !!ae?.closest(".cm-editor");

  if (editorFocused && activePane?.getVimMode() === "insert") return; // typing

  // ---- resolve a pending sidebar sequence ----
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

// ---- Multiplexer key layer -------------------------------------------------
// tmux-style pane control, independent of Vim mode. A prefix (Ctrl-b) arms
// `muxPending`; the next key splits/closes/cycles/moves focus. Registered in
// the capture phase BEFORE vimDispatch so consumed keys never reach the Vim
// layer, the bubble-phase shortcuts, or the editor.
let muxPending = false;
let muxTimer: number | undefined;
function setMuxPending(on: boolean) {
  muxPending = on;
  window.clearTimeout(muxTimer);
  if (on) muxTimer = window.setTimeout(() => (muxPending = false), 1500);
}

function muxDispatch(e: KeyboardEvent) {
  const ae = document.activeElement as HTMLElement | null;
  // Text inputs (search, inline rename, prompt modal) own their own keys.
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
  if (openMenu) return; // an open menu handles keys itself
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return; // bare modifier

  // Resolve the follow-up key. Works in any editor mode (CodeMirror is
  // contenteditable, not an INPUT) since the prefix is caught first.
  if (muxPending) {
    setMuxPending(false);
    e.preventDefault();
    e.stopImmediatePropagation();
    switch (e.key) {
      case "v": splitActive("row"); break; // side-by-side / vsplit
      case "s": splitActive("col"); break; // stacked / hsplit
      case "x":
      case "c":
      case "q": void closePane(); break;
      case "o":
      case "w": cyclePane(); break;
      case "h": case "ArrowLeft": focusDir("h"); break;
      case "j": case "ArrowDown": focusDir("j"); break;
      case "k": case "ArrowUp": focusDir("k"); break;
      case "l": case "ArrowRight": focusDir("l"); break;
    }
    return;
  }

  // Arm the prefix: Ctrl-b (tmux) — Ctrl-l kept as an alias.
  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "b" || k === "l" || e.code === "KeyB" || e.code === "KeyL") {
      e.preventDefault();
      e.stopImmediatePropagation();
      setMuxPending(true);
    }
  }
}

document.addEventListener("keydown", muxDispatch, true);
document.addEventListener("keydown", vimDispatch, true);

// ---- Boot ------------------------------------------------------------------
(async function init() {
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    // Capture the layout before openVault mounts a pane and rewrites the key.
    const savedLayout = localStorage.getItem(TABS_KEY);
    try {
      await openVault(saved);
      await restoreLayout(savedLayout);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
})();
