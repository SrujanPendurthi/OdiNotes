import "./style.css";
import { Fzf, type FzfResultItem } from "fzf";
import { createEditor, type EditorHandle } from "./editor";
import {
  type FileNode,
  pickVault,
  listTree,
  readFile,
  writeFile,
  createFile,
  createDir,
  movePath,
} from "./vault";

const STORAGE_KEY = "odinotes.vault";

// ---- App state -------------------------------------------------------------
let vaultPath: string | null = null;
let currentFile: string | null = null;
let activeDir: string | null = null; // where new notes/folders land
let tree: FileNode[] = [];
const collapsed = new Set<string>();
let dragSrcPath: string | null = null; // file/folder being dragged

let editor: EditorHandle;
let suppressChange = false; // ignore the change event fired while loading a file
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

// ---- Editor wiring ---------------------------------------------------------
editor = createEditor($("editor"), (doc) => {
  if (suppressChange || !currentFile) return;
  scheduleSave(doc);
});

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
  vaultPath = path;
  activeDir = path;
  localStorage.setItem(STORAGE_KEY, path);
  searchEl.disabled = false;
  searchEl.title = path;
  searchEl.placeholder = `Search ${basename(path)}…`;
  btnNewFile.disabled = false;
  btnNewFolder.disabled = false;
  await refreshTree();
}

async function refreshTree() {
  if (!vaultPath) return;
  tree = await listTree(vaultPath);
  renderTree();
  rebuildSearchIndex();
  // Keep an active search in sync with files that were just created/moved.
  if (searchEl.value.trim()) runSearch(searchEl.value);
}

async function openFile(path: string) {
  // Flush any pending save for the previous file first.
  window.clearTimeout(saveTimer);
  if (currentFile) {
    try {
      await writeFile(currentFile, editor.getDoc());
    } catch {
      /* best effort */
    }
  }

  const text = await readFile(path);
  suppressChange = true;
  editor.setDoc(text);
  suppressChange = false;

  currentFile = path;
  activeDir = dirname(path);
  emptyStateEl.classList.add("hidden");
  statusPathEl.textContent = relativeToVault(path);
  statusSaveEl.textContent = "Saved";
  editor.focus();
  renderTree();
}

// ---- Sidebar rendering -----------------------------------------------------
function renderTree() {
  treeEl.innerHTML = "";
  treeEl.appendChild(renderNodes(tree, 0));
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

  const chevron = document.createElement("span");
  chevron.className = "shrink-0 text-muted transition-transform";
  chevron.style.transform = isCollapsed ? "rotate(-90deg)" : "rotate(0deg)";
  chevron.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  const label = document.createElement("span");
  label.className = "truncate font-medium";
  label.textContent = node.name;

  row.append(chevron, label);
  row.addEventListener("click", () => {
    if (collapsed.has(node.path)) collapsed.delete(node.path);
    else collapsed.add(node.path);
    activeDir = node.path;
    renderTree();
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    activeDir = node.path;
    showContextMenu(e.clientX, e.clientY, node.path);
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

  const dot = document.createElement("span");
  dot.className = "shrink-0 text-muted";
  dot.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = node.name.replace(/\.md$/i, "");

  row.append(dot, label);
  row.addEventListener("click", () => openFile(node.path));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, dirname(node.path));
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

async function moveInto(src: string | null, destDir: string) {
  if (!src) return;
  dragSrcPath = null;
  // No-op when dropping an item back into its current parent.
  if (dirname(src) === destDir) return;

  try {
    const newPath = await movePath(src, destDir);
    // If the open file (or its containing folder) moved, follow it.
    if (currentFile === src) {
      currentFile = newPath;
      statusPathEl.textContent = relativeToVault(currentFile);
    } else if (currentFile && currentFile.startsWith(src + "/")) {
      currentFile = newPath + currentFile.slice(src.length);
      statusPathEl.textContent = relativeToVault(currentFile);
    }
    if (activeDir === src) activeDir = newPath;
    await refreshTree();
  } catch (e) {
    alertModal(String(e));
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
  const name = await promptModal("New note", "Untitled");
  if (!name) return;
  try {
    const path = await createFile(dir, name);
    await refreshTree();
    await openFile(path);
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

function showContextMenu(x: number, y: number, dir: string) {
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

  document.body.appendChild(menu);
  openMenu = menu;

  // Nudge back on-screen if opened near a right/bottom edge.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;

  // Close only on a *new* press outside the menu. Deferring the binding past
  // this event loop tick keeps the opening right-click from closing it instantly.
  dismissHandler = (e: Event) => {
    if (openMenu && !openMenu.contains(e.target as Node)) closeContextMenu();
  };
  setTimeout(() => {
    if (dismissHandler) {
      document.addEventListener("pointerdown", dismissHandler, true);
    }
  }, 0);
}

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
});

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
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      await openVault(saved);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
})();
