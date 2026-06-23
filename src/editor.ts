// CodeMirror 6 editor with an Obsidian-style live-preview layer:
// markdown formatting renders in place, and the raw syntax markers
// (`#`, `**`, `*`, `` ` ``, `~~`) are hidden until the cursor enters them.
import {
  EditorState,
  Range,
  ChangeSet,
  RangeSetBuilder,
  type ChangeSpec,
  type Text,
} from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  EditorView,
  keymap,
  drawSelection,
  Decoration,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentLess,
} from "@codemirror/commands";
import {
  syntaxTree,
  syntaxHighlighting,
  HighlightStyle,
  getIndentUnit,
  indentString,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";

export interface EditorHandle {
  setDoc(text: string): void;
  getDoc(): string;
  focus(): void;
  destroy(): void;
}

// Map heading node names to the CSS class that sizes them.
const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "cm-h1",
  ATXHeading2: "cm-h2",
  ATXHeading3: "cm-h3",
  ATXHeading4: "cm-h4",
  ATXHeading5: "cm-h5",
  ATXHeading6: "cm-h6",
};

// Mark decorations that style the rendered content.
const CONTENT_CLASS: Record<string, string> = {
  StrongEmphasis: "cm-strong",
  Emphasis: "cm-emphasis",
  Strikethrough: "cm-strike",
  InlineCode: "cm-inline-code",
};

// Syntax markers we hide when the cursor is elsewhere.
const MARK_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
]);

const hidden = Decoration.replace({});

/** True if any selection range overlaps [from, to]. */
function selectionTouches(view: EditorView, from: number, to: number): boolean {
  for (const r of view.state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

function buildDecorations(view: EditorView): DecorationSet {
  const deco: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        const headingClass = HEADING_CLASS[name];
        if (headingClass) {
          deco.push(
            Decoration.mark({ class: headingClass }).range(node.from, node.to),
          );
          return;
        }

        const contentClass = CONTENT_CLASS[name];
        if (contentClass) {
          deco.push(
            Decoration.mark({ class: contentClass }).range(node.from, node.to),
          );
        }

        if (MARK_NODES.has(name)) {
          const parent = node.node.parent;
          const pf = parent ? parent.from : node.from;
          const pt = parent ? parent.to : node.to;
          if (!selectionTouches(view, pf, pt)) {
            let end = node.to;
            // Also swallow the space after a heading's `#` markers.
            if (
              name === "HeaderMark" &&
              view.state.doc.sliceString(end, end + 1) === " "
            ) {
              end += 1;
            }
            deco.push(hidden.range(node.from, end));
          }
        }
      },
    });
  }

  // Decoration.set with sort=true tolerates our out-of-order pushes.
  return Decoration.set(deco, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Hanging indent for wrapped lines: continuation rows of a soft-wrapped line
// align under where its content starts (past leading whitespace and any list
// marker) instead of falling back to the left wall. Achieved per line with a
// negative text-indent (pulls the first row back to the real left edge) plus a
// matching padding-left (pushes every row, including wraps, to the right).
// Indent unit is spaces here, so prefix length maps 1:1 to `ch`.
const PREFIX_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?/;

function buildHangingIndents(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const width = PREFIX_RE.exec(line.text)?.[0].length ?? 0;
      if (width > 0) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            attributes: {
              style: `padding-left:${width}ch;text-indent:-${width}ch`,
            },
          }),
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHangingIndents(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) {
        this.decorations = buildHangingIndents(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Syntax colouring for fenced code blocks and inline tokens.
const highlightStyle = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "#7aa2f7", textDecoration: "underline" },
  { tag: t.url, color: "#565f89" },
  { tag: t.monospace, color: "#bb9af7" },
  { tag: t.keyword, color: "#bb9af7" },
  { tag: t.comment, color: "#565f89", fontStyle: "italic" },
  { tag: t.string, color: "#9ece6a" },
  { tag: t.number, color: "#ff9e64" },
  { tag: [t.name, t.propertyName], color: "#7dcfff" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "transparent" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { overflow: "auto" },
  },
  { dark: true },
);

// ---- List-aware Tab handling ----------------------------------------------
// Tab nests the current Markdown list item and its children (indent);
// Shift+Tab promotes it (outdent). Outside a list these commands return false
// so the generic indentMore/indentLess fallbacks handle ordinary text.

/** Climb to the enclosing ListItem node at `pos`, or null if not in a list. */
function listItemAt(state: EditorState, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (node.name === "ListItem") return node;
    node = node.parent;
  }
  return null;
}

/**
 * Line numbers that should move when (out)denting the current selection.
 * Each touched list item contributes its full line span — a ListItem node
 * includes its nested sub-lists, so children come along automatically. The
 * set dedupes so an item counted both on its own and via its parent only
 * moves once.
 */
function listLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const sel of state.selection.ranges) {
    const first = state.doc.lineAt(sel.from).number;
    const last = state.doc.lineAt(sel.to).number;
    for (let n = first; n <= last; n++) {
      const item = listItemAt(state, state.doc.line(n).from);
      if (!item) continue;
      const from = state.doc.lineAt(item.from).number;
      const to = state.doc.lineAt(item.to).number;
      for (let m = from; m <= to; m++) lines.add(m);
    }
  }
  return lines;
}

/**
 * Rewrite ordered-list markers so each nesting level numbers sequentially
 * (each new deeper level restarts at 1). Computed by a plain line scan rather
 * than the syntax tree, which lags one parse behind an edit. Bullet lists are
 * ignored. Returns changes in `doc` coordinates.
 */
function renumberOrderedLists(doc: Text): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  const stack: { indent: number; next: number }[] = [];
  const re = /^(\s*)(\d+)([.)])(\s)/;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const m = re.exec(line.text);
    if (!m) {
      // A non-blank, non-ordered line closes any list at its indent or deeper.
      if (line.text.trim() !== "") {
        const lead = line.text.length - line.text.trimStart().length;
        while (stack.length && stack[stack.length - 1].indent >= lead) stack.pop();
      }
      continue;
    }
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || top.indent < indent) {
      top = { indent, next: 1 };
      stack.push(top);
    }
    const expected = top.next++;
    if (parseInt(m[2], 10) !== expected) {
      const from = line.from + m[1].length;
      changes.push({ from, to: from + m[2].length, insert: String(expected) });
    }
  }
  return changes;
}

/** Apply indent changes and a renumber pass as a single undo step. */
function dispatchListChange(view: EditorView, indentChanges: ChangeSpec[]): void {
  const indentSet = view.state.changes(indentChanges);
  const newDoc = indentSet.apply(view.state.doc);
  const renumberSet = ChangeSet.of(renumberOrderedLists(newDoc), newDoc.length);
  view.dispatch({
    changes: indentSet.compose(renumberSet),
    userEvent: "indent",
  });
}

function indentList(view: EditorView): boolean {
  const { state } = view;
  const lines = listLines(state);
  if (lines.size === 0) return false;
  const unit = indentString(state, getIndentUnit(state));
  const changes: ChangeSpec[] = [];
  for (const n of lines) {
    const line = state.doc.line(n);
    if (line.length === 0) continue; // don't add trailing whitespace
    changes.push({ from: line.from, insert: unit });
  }
  dispatchListChange(view, changes);
  return true;
}

function outdentList(view: EditorView): boolean {
  const { state } = view;
  const lines = listLines(state);
  if (lines.size === 0) return false;
  const width = getIndentUnit(state);
  const changes: ChangeSpec[] = [];
  for (const n of lines) {
    const text = state.doc.line(n).text;
    let removed = 0;
    let i = 0;
    while (i < text.length && removed < width) {
      if (text[i] === "\t") removed += width;
      else if (text[i] === " ") removed += 1;
      else break;
      i++;
    }
    if (i > 0) {
      const from = state.doc.line(n).from;
      changes.push({ from, to: from + i, insert: "" });
    }
  }
  if (changes.length === 0) return false; // nothing to outdent; let fallback run
  dispatchListChange(view, changes);
  return true;
}

export function createEditor(
  parent: HTMLElement,
  onChange: (doc: string) => void,
): EditorHandle {
  const listener = EditorView.updateListener.of((u) => {
    if (u.docChanged) onChange(u.state.doc.toString());
  });

  const state = EditorState.create({
    doc: "",
    extensions: [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      // Tab nests the current list item (indent); Shift+Tab promotes it
      // (outdent). The list-aware commands run first and fall through to
      // generic indent/outdent outside a list. Listed before defaultKeymap so
      // the editor claims the Tab key.
      keymap.of([
        { key: "Tab", run: indentList },
        { key: "Tab", run: indentMore },
        { key: "Shift-Tab", run: outdentList },
        { key: "Shift-Tab", run: indentLess },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [GFM],
      }),
      syntaxHighlighting(highlightStyle),
      livePreview,
      hangingIndent,
      theme,
      listener,
    ],
  });

  const view = new EditorView({ state, parent });

  return {
    setDoc(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    getDoc() {
      return view.state.doc.toString();
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}
