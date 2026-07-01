// A single editor pane: its own tab strip + CodeMirror view, owning the set of
// open tabs and the active one. Extracted from main.ts so the workspace can host
// a tree of these for tmux-style splits. All filesystem-affecting decisions stay
// in main.ts (the controller); a Pane only manages its own tabs/editor and emits
// callbacks for workspace-level concerns (focus, status, persistence).
import { createEditor, type EditorHandle } from "./editor";
import { readFile, writeFile } from "./vault";
import { basename } from "./paths";

let paneSeq = 0;

export interface PaneDeps {
  vimEnabled: boolean;
  onActivate: (pane: Pane) => void; // user interacted with this pane
  onActiveChange: (pane: Pane) => void; // active tab changed → status + persist
  onNewNote: (pane: Pane) => void; // trailing "+" / empty state
  onSaveStatus: (pane: Pane, text: string) => void; // debounced-save feedback
  onSplit: (pane: Pane, dir: "row" | "col") => void; // split button
  onClosePane: (pane: Pane) => void; // close-pane button
  // Resolve a link target (wikilink / relative .md) to an absolute path or null.
  resolveLink: (target: string, from: string | null, relative?: boolean) => string | null;
  onFollowLink: (path: string) => void; // Cmd/Ctrl+click a link → open it
}

const FILE_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

export class Pane {
  readonly id = `pane-${paneSeq++}`;
  readonly el: HTMLElement; // container mounted into the pane tree
  readonly editor: EditorHandle;
  tabs: string[] = [];
  activeTab: string | null = null;

  private readonly tabbarEl: HTMLElement;
  private readonly mountEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private saveTimer?: number;
  private canClose = false; // show the close-pane button (set by the workspace)

  constructor(private deps: PaneDeps) {
    this.el = document.createElement("div");
    this.el.className = "flex min-h-0 min-w-0 flex-1 flex-col bg-bg";
    this.el.dataset.paneId = this.id;

    this.tabbarEl = document.createElement("div");
    this.tabbarEl.className =
      "flex h-8 shrink-0 items-stretch border-b border-border bg-panel";

    const wrap = document.createElement("div");
    wrap.className = "relative min-h-0 flex-1 overflow-hidden";
    this.emptyEl = document.createElement("div");
    this.emptyEl.className =
      "pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-muted";
    this.emptyEl.innerHTML = `${FILE_SVG.replace('width="12" height="12"', 'width="40" height="40" stroke-width="1.5"')}<p class="text-sm">Pick or create a note.</p>`;
    this.mountEl = document.createElement("div");
    this.mountEl.className = "h-full w-full select-text";
    wrap.append(this.emptyEl, this.mountEl);
    this.el.append(this.tabbarEl, wrap);

    this.editor = createEditor(
      this.mountEl,
      (doc) => {
        if (this.activeTab) this.scheduleSave(doc);
      },
      {
        vimEnabled: deps.vimEnabled,
        onSave: () => {
          void this.flushSave().then(() => {
            if (this.activeTab) deps.onSaveStatus(this, "Saved");
          });
        },
        onCloseTab: () => {
          if (this.activeTab) void this.closeTab(this.activeTab);
        },
        resolveLink: (t, from, rel) =>
          deps.resolveLink(t, from ?? this.activeTab, rel),
        onFollowLink: (p) => deps.onFollowLink(p),
      },
    );

    // Any interaction makes this the active pane.
    this.el.addEventListener("mousedown", () => this.deps.onActivate(this), true);
    this.el.addEventListener("focusin", () => this.deps.onActivate(this));

    this.renderTabs();
  }

  // ---- focus / vim ----
  focus() {
    if (this.activeTab) this.editor.focus();
  }
  setActiveRing(active: boolean) {
    this.el.classList.toggle("ring-1", active);
    this.el.classList.toggle("ring-inset", active);
    this.el.classList.toggle("ring-accent/60", active);
  }
  setVim(enabled: boolean) {
    this.editor.setVim(enabled);
  }
  // Toggle the close-pane button (hidden when this is the only pane).
  setCanClose(enabled: boolean) {
    if (this.canClose === enabled) return;
    this.canClose = enabled;
    this.renderTabs();
  }
  getVimMode() {
    return this.editor.getVimMode();
  }

  // ---- save ----
  private scheduleSave(doc: string) {
    this.deps.onSaveStatus(this, "Saving…");
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(async () => {
      if (!this.activeTab) return;
      try {
        await writeFile(this.activeTab, doc);
        this.deps.onSaveStatus(this, "Saved");
      } catch (e) {
        this.deps.onSaveStatus(this, `Error: ${e}`);
      }
    }, 400);
  }
  // Flush the active tab's pending save to disk before switching away.
  async flushSave() {
    window.clearTimeout(this.saveTimer);
    if (this.activeTab) {
      try {
        await writeFile(this.activeTab, this.editor.getDoc());
      } catch {
        /* best effort */
      }
    }
  }

  // ---- tabs ----
  private setActive(path: string | null) {
    this.activeTab = path;
    this.emptyEl.classList.toggle("hidden", path !== null);
    if (path) this.editor.focus();
    this.renderTabs();
    this.deps.onActiveChange(this);
  }

  has(path: string): boolean {
    return this.tabs.includes(path);
  }
  isEmpty(): boolean {
    return this.tabs.length === 0;
  }

  // Open a note in its own tab: focus it if already open, else append + focus.
  async openFile(path: string) {
    if (path === this.activeTab) return;
    if (this.tabs.includes(path)) return this.activateTab(path);
    await this.flushSave();
    const text = await readFile(path);
    const at = this.activeTab ? this.tabs.indexOf(this.activeTab) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, path);
    this.editor.openDoc(path, text);
    this.setActive(path);
  }

  async activateTab(path: string) {
    if (path === this.activeTab) return;
    await this.flushSave();
    this.editor.openDoc(path, "");
    this.setActive(path);
  }

  async closeTab(path: string) {
    const idx = this.tabs.indexOf(path);
    if (idx === -1) return;
    if (path === this.activeTab) await this.flushSave();
    this.tabs.splice(idx, 1);
    this.editor.closeDoc(path);
    if (path !== this.activeTab) {
      this.renderTabs();
      this.deps.onActiveChange(this);
      return;
    }
    const next = this.tabs[idx] ?? this.tabs[idx - 1] ?? null;
    if (next) {
      this.editor.openDoc(next, "");
      this.setActive(next);
    } else {
      this.editor.clear();
      this.setActive(null);
    }
  }

  // Drop tabs WITHOUT saving (their files are being trashed), picking the
  // nearest surviving neighbour if the active tab is among them.
  forgetTabs(paths: string[]) {
    const doomed = new Set(paths);
    const oldTabs = this.tabs.slice();
    const hitActive = this.activeTab !== null && doomed.has(this.activeTab);
    if (hitActive) window.clearTimeout(this.saveTimer);
    for (const p of paths) if (oldTabs.includes(p)) this.editor.closeDoc(p);
    this.tabs = oldTabs.filter((p) => !doomed.has(p));
    if (!hitActive) {
      this.renderTabs();
      this.deps.onActiveChange(this);
      return;
    }
    const at = oldTabs.indexOf(this.activeTab!);
    let next: string | null = null;
    for (let i = at + 1; i < oldTabs.length && !next; i++)
      if (!doomed.has(oldTabs[i])) next = oldTabs[i];
    for (let i = at - 1; i >= 0 && !next; i--)
      if (!doomed.has(oldTabs[i])) next = oldTabs[i];
    if (next) {
      this.editor.openDoc(next, "");
      this.setActive(next);
    } else {
      this.editor.clear();
      this.setActive(null);
    }
  }

  // Reflect a file move/rename in this pane's tabs + retained editor state.
  remap(remapper: (p: string) => string) {
    this.tabs = this.tabs.map((p) => {
      const np = remapper(p);
      if (np !== p) this.editor.renameDoc(p, np);
      return np;
    });
    if (this.activeTab) this.activeTab = remapper(this.activeTab);
  }

  // ---- persistence ----
  serialize(): { tabs: string[]; active: string | null } {
    return { tabs: this.tabs.slice(), active: this.activeTab };
  }
  // Restore validated tabs (caller guarantees the files exist). Loads the active
  // doc; other tabs lazy-load when first activated.
  async restore(tabs: string[], active: string | null) {
    this.tabs = tabs.slice();
    const target = active && tabs.includes(active) ? active : (tabs[0] ?? null);
    if (target) {
      const text = await readFile(target);
      this.editor.openDoc(target, text);
      this.setActive(target);
    } else {
      this.renderTabs();
    }
  }

  destroy() {
    window.clearTimeout(this.saveTimer);
    this.editor.destroy();
    this.el.remove();
  }

  // ---- tab strip rendering ----
  private renderTabs() {
    this.tabbarEl.innerHTML = "";

    // Scrollable tabs region (tabs + the trailing "+").
    const tabsWrap = document.createElement("div");
    tabsWrap.className = "flex min-w-0 flex-1 items-stretch overflow-x-auto";
    for (const path of this.tabs) {
      const active = path === this.activeTab;
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
        void this.closeTab(path);
      });

      tab.append(label, close);
      tab.addEventListener("click", () => void this.activateTab(path));
      tab.addEventListener("auxclick", (e) => {
        if (e.button === 1) {
          e.preventDefault();
          void this.closeTab(path);
        }
      });
      tabsWrap.appendChild(tab);
    }

    const add = document.createElement("button");
    add.title = "New note";
    add.className =
      "flex shrink-0 items-center justify-center px-2 text-muted hover:bg-border/40 hover:text-fg";
    add.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    add.addEventListener("click", () => this.deps.onNewNote(this));
    tabsWrap.appendChild(add);

    // Pinned (non-scrolling) pane controls on the right.
    const controls = document.createElement("div");
    controls.className =
      "flex shrink-0 items-stretch border-l border-border bg-panel";
    controls.appendChild(
      this.controlBtn(
        "Split right",
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>',
        () => this.deps.onSplit(this, "row"),
      ),
    );
    if (this.canClose) {
      controls.appendChild(
        this.controlBtn(
          "Close pane",
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>',
          () => this.deps.onClosePane(this),
        ),
      );
    }

    this.tabbarEl.append(tabsWrap, controls);
  }

  private controlBtn(title: string, svg: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.title = title;
    b.className =
      "flex shrink-0 items-center justify-center px-2 text-muted hover:bg-border/40 hover:text-fg";
    b.innerHTML = svg;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }
}
