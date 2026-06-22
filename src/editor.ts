// CodeMirror 6 editor with an Obsidian-style live-preview layer:
// markdown formatting renders in place, and the raw syntax markers
// (`#`, `**`, `*`, `` ` ``, `~~`) are hidden until the cursor enters them.
import { EditorState, Range } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  Decoration,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  syntaxTree,
  syntaxHighlighting,
  HighlightStyle,
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
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [GFM],
      }),
      syntaxHighlighting(highlightStyle),
      livePreview,
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
