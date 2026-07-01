// The link model shared by the editor (wikilink rendering + click navigation)
// and the graph view. This module is the SINGLE source of truth for how a note
// references another: the link regexes live here and are imported by editor.ts
// so their semantics never diverge.
//
// Two link forms are recognised:
//   - Wikilinks `[[Target]]` / `[[Target|alias]]` — resolved vault-relative or
//     by bare basename (Obsidian shortest-path).
//   - Standard Markdown links `[text](note.md)` — resolved relative to the
//     source note's own folder (only when the href is a relative `.md` path).
import type { FileNode } from "./vault";
import { basename, dirname, relativeToVault } from "./paths";

// `[[` target (no `]`, `|`, `#`, or newline) + optional `#anchor` + optional
// `|alias`, then `]]`. g1 = target, g2 = alias (display text when present).
export const WIKILINK_RE = /\[\[([^\]|\n#]+)(?:#[^\]|\n]+)?(?:\|([^\]\n]+))?\]\]/g;

// A Markdown link whose href is a relative `.md` path: `[text](path.md)` with an
// optional `#anchor`. g1 = href (may contain `/`). http(s):// and absolute hrefs
// are filtered out in `extractLinks`.
export const MDLINK_RE = /\[[^\]]*\]\(([^)\s]+?\.md)(?:#[^)]*)?\)/g;

/** A raw reference pulled out of a note's text. */
export interface LinkRef {
  target: string; // link target, `.md`/`#anchor` stripped
  relative: boolean; // true = Markdown link (resolve rel. to source dir)
}

export interface GraphNode {
  id: string; // absolute path (also the node's identity)
  label: string; // basename without `.md`
  path: string; // absolute path (all nodes are existing files)
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type Resolver = (
  target: string,
  fromPath: string | null,
  relative?: boolean,
) => string | null;

/** Collapse `.`/`..` segments in a POSIX path (keeps a leading `/`). */
function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

/** Strip a trailing `.md` (case-insensitive) and any `#anchor`. */
function cleanTarget(t: string): string {
  return t.trim().replace(/#.*$/, "").replace(/\.md$/i, "");
}

/** Pull every wikilink + relative Markdown-link reference out of `text`. */
export function extractLinks(text: string): LinkRef[] {
  const refs: LinkRef[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    if (target) refs.push({ target, relative: false });
  }
  for (const m of text.matchAll(MDLINK_RE)) {
    let href = m[1];
    // Skip external and vault-absolute hrefs — only intra-vault relative links
    // become edges.
    if (/^[a-z]+:\/\//i.test(href) || href.startsWith("/")) continue;
    try {
      href = decodeURIComponent(href);
    } catch {
      /* leave as-is if it isn't valid percent-encoding */
    }
    refs.push({ target: href, relative: true });
  }
  return refs;
}

/**
 * Build a resolver mapping a link target to an existing note's absolute path,
 * or null. Wikilinks resolve vault-relative (with a slash) or by bare basename
 * (Obsidian shortest-path, case-insensitive, preferring a match in the source
 * note's folder); Markdown links resolve relative to the source note's folder.
 */
export function buildResolver(
  tree: FileNode[],
  vaultPath: string | null,
): Resolver {
  // Lowercased absolute path -> actual-cased path (existence + case-fold).
  const absMap = new Map<string, string>();
  // Lowercased vault-relative path (no `.md`) -> actual path.
  const relMap = new Map<string, string>();
  // Lowercased basename (no `.md`) -> actual paths (may collide across folders).
  const baseMap = new Map<string, string[]>();

  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      if (n.is_dir) {
        walk(n.children);
        continue;
      }
      absMap.set(n.path.toLowerCase(), n.path);
      const rel = relativeToVault(n.path, vaultPath).replace(/\.md$/i, "");
      relMap.set(rel.toLowerCase(), n.path);
      const base = basename(n.path).replace(/\.md$/i, "").toLowerCase();
      const list = baseMap.get(base);
      if (list) list.push(n.path);
      else baseMap.set(base, [n.path]);
    }
  };
  walk(tree);

  return (target, fromPath, relative = false) => {
    const clean = cleanTarget(target);
    if (!clean) return null;

    // Markdown links: resolve against the source note's own directory.
    if (relative && fromPath) {
      const abs = normalizePath(`${dirname(fromPath)}/${clean}.md`);
      const hit = absMap.get(abs.toLowerCase());
      if (hit) return hit;
    }

    // Wikilinks with a slash: treat as a vault-relative path.
    if (clean.includes("/")) {
      return relMap.get(clean.toLowerCase()) ?? null;
    }

    // Bare name: match by basename, preferring the source note's folder.
    const candidates = baseMap.get(clean.toLowerCase());
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1 || !fromPath) return candidates[0];
    const dir = dirname(fromPath);
    return candidates.find((p) => dirname(p) === dir) ?? candidates[0];
  };
}

/**
 * Build the graph: one node per note, an undirected edge per resolved link.
 * Unresolved links and self-links are dropped; edges are de-duplicated.
 */
export function buildGraph(
  notes: { path: string; content: string }[],
  tree: FileNode[],
  vaultPath: string | null,
): Graph {
  const resolve = buildResolver(tree, vaultPath);
  const ids = new Set(notes.map((n) => n.path));

  const nodes: GraphNode[] = notes.map((n) => ({
    id: n.path,
    label: basename(n.path).replace(/\.md$/i, ""),
    path: n.path,
    degree: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
  }));
  const nodeById = new Map(nodes.map((nd) => [nd.id, nd]));

  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const note of notes) {
    for (const ref of extractLinks(note.content)) {
      const dest = resolve(ref.target, note.path, ref.relative);
      if (!dest || dest === note.path || !ids.has(dest)) continue;
      const key = note.path < dest ? `${note.path}\0${dest}` : `${dest}\0${note.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: note.path, target: dest });
      nodeById.get(note.path)!.degree++;
      nodeById.get(dest)!.degree++;
    }
  }

  // Seed positions deterministically on a circle so the force sim starts from a
  // non-degenerate layout (all-zero would make repulsion explode).
  const R = 300;
  nodes.forEach((nd, i) => {
    const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    nd.x = Math.cos(a) * R;
    nd.y = Math.sin(a) * R;
  });

  return { nodes, edges };
}
