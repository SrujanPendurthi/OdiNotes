// A dependency-free, hand-rolled force-directed graph rendered on a <canvas>.
// Mounts as an opaque overlay inside #editor-wrap (same idiom as #empty-state).
// The simulation loop stops once the layout settles so an open graph costs no
// idle CPU; interactions (pan/zoom/drag/hover) reheat or re-render as needed.
import type { Graph, GraphNode } from "./graph";

// ---- Simulation tuning -----------------------------------------------------
const REPULSION = 7000; // pairwise inverse-square push strength
const SPRING = 0.03; // Hooke pull along edges
const REST_LEN = 90; // edge rest length (world units)
const GRAVITY = 0.025; // weak pull toward the origin (keeps islands on-screen)
const DAMPING = 0.82; // velocity decay per tick
const COOL = 0.98; // alpha cooling factor
const ALPHA_MIN = 0.005; // below this the sim is considered settled
const MAX_V = 40; // velocity clamp (prevents blow-ups)

const CLICK_SLOP = 4; // px of movement below which a press counts as a click
const LABEL_ZOOM = 0.9; // draw all labels once zoomed in past this scale

export class GraphView {
  private readonly overlay: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly ro: ResizeObserver;

  private nodes: GraphNode[] = [];
  private edges: { source: GraphNode; target: GraphNode }[] = [];
  private neighbors = new Map<GraphNode, Set<GraphNode>>();

  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private alpha = 0;
  private raf = 0;

  // Pointer interaction state.
  private dragNode: GraphNode | null = null;
  private panning = false;
  private hover: GraphNode | null = null;
  private downX = 0;
  private downY = 0;
  private moved = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: { onOpenFile: (path: string) => void },
  ) {
    this.overlay = document.createElement("div");
    this.overlay.className = "absolute inset-0 z-20 hidden bg-bg";

    this.canvas = document.createElement("canvas");
    this.canvas.className = "h-full w-full";
    this.canvas.style.touchAction = "none";
    this.ctx = this.canvas.getContext("2d")!;

    const close = document.createElement("button");
    close.title = "Close graph (Esc)";
    close.className =
      "absolute right-3 top-3 z-10 rounded p-1.5 text-muted hover:bg-border hover:text-fg";
    close.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
    close.addEventListener("click", () => this.close());

    this.overlay.append(this.canvas, close);
    this.container.appendChild(this.overlay);

    this.ro = new ResizeObserver(() => {
      if (!this.isOpen()) return;
      this.resize();
      this.renderOnce();
    });
    this.ro.observe(this.overlay);

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("dblclick", this.onDblClick);
  }

  isOpen(): boolean {
    return !this.overlay.classList.contains("hidden");
  }

  open(graph: Graph) {
    this.nodes = graph.nodes;
    this.neighbors = new Map(this.nodes.map((n) => [n, new Set<GraphNode>()]));
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = [];
    for (const e of graph.edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      this.edges.push({ source: a, target: b });
      this.neighbors.get(a)!.add(b);
      this.neighbors.get(b)!.add(a);
    }
    this.overlay.classList.remove("hidden");
    this.resize();
    // Recenter the view and reheat the simulation.
    this.scale = 1;
    this.offsetX = this.canvas.clientWidth / 2;
    this.offsetY = this.canvas.clientHeight / 2;
    this.hover = null;
    this.reheat();
  }

  close() {
    if (!this.isOpen()) return;
    this.overlay.classList.add("hidden");
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.overlay.remove();
  }

  // ---- Canvas sizing (device-pixel crisp) ----------------------------------
  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.overlay.clientWidth;
    const h = this.overlay.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  // ---- Coordinate transforms ------------------------------------------------
  private toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.offsetX) / this.scale, y: (sy - this.offsetY) / this.scale };
  }

  private radius(n: GraphNode): number {
    return 4 + 2 * Math.sqrt(n.degree);
  }

  // ---- Simulation -----------------------------------------------------------
  private reheat() {
    this.alpha = 0.6;
    this.kick();
  }

  private kick() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.step();
    this.render();
    if (this.alpha > ALPHA_MIN || this.dragNode) {
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.raf = 0;
    }
  };

  private step() {
    const nodes = this.nodes;
    if (nodes.length === 0) return;

    // Repulsion (O(n²) — fine for typical vaults).
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          // Coincident nodes: nudge apart deterministically.
          dx = (i - j) || 1;
          dy = 1;
          d2 = dx * dx + dy * dy;
        }
        const f = REPULSION / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Springs along edges.
    for (const e of this.edges) {
      const a = e.source;
      const b = e.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = SPRING * (d - REST_LEN);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Gravity toward the origin + integration.
    for (const n of nodes) {
      if (n === this.dragNode) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx = (n.vx - GRAVITY * n.x) * DAMPING;
      n.vy = (n.vy - GRAVITY * n.y) * DAMPING;
      n.vx = Math.max(-MAX_V, Math.min(MAX_V, n.vx));
      n.vy = Math.max(-MAX_V, Math.min(MAX_V, n.vy));
      n.x += n.vx * this.alpha;
      n.y += n.vy * this.alpha;
    }

    this.alpha *= COOL;
  }

  // ---- Rendering ------------------------------------------------------------
  private renderOnce() {
    if (!this.raf) this.render();
  }

  private render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.overlay.clientWidth, this.overlay.clientHeight);
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    const focus = this.hover;
    const near = focus ? this.neighbors.get(focus) : null;
    const isLit = (n: GraphNode) => !focus || n === focus || !!near?.has(n);

    // Edges.
    ctx.lineWidth = 1 / this.scale;
    for (const e of this.edges) {
      const lit = focus ? e.source === focus || e.target === focus : true;
      ctx.strokeStyle = lit ? "rgba(122,162,247,0.55)" : "rgba(192,202,245,0.10)";
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.stroke();
    }

    // Nodes.
    for (const n of this.nodes) {
      const r = this.radius(n);
      const lit = isLit(n);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = lit ? "#7aa2f7" : "rgba(122,162,247,0.28)";
      ctx.fill();
      if (n === focus) {
        ctx.lineWidth = 2 / this.scale;
        ctx.strokeStyle = "#c0caf5";
        ctx.stroke();
      }
    }

    // Labels: everything when zoomed in, otherwise only the focused cluster.
    const showAll = this.scale >= LABEL_ZOOM;
    ctx.fillStyle = "#c0caf5";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = `${11 / this.scale}px ui-sans-serif, system-ui, sans-serif`;
    for (const n of this.nodes) {
      if (!showAll && !(focus && isLit(n))) continue;
      ctx.globalAlpha = isLit(n) ? 1 : 0.35;
      ctx.fillText(n.label, n.x, n.y + this.radius(n) + 2 / this.scale);
    }
    ctx.globalAlpha = 1;
  }

  // ---- Interaction ----------------------------------------------------------
  private nodeAt(sx: number, sy: number): GraphNode | null {
    const w = this.toWorld(sx, sy);
    let best: GraphNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const dx = n.x - w.x;
      const dy = n.y - w.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const hit = this.radius(n) + 4 / this.scale;
      if (d <= hit && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private localXY(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onPointerDown = (e: PointerEvent) => {
    const { x, y } = this.localXY(e);
    this.downX = x;
    this.downY = y;
    this.moved = 0;
    this.canvas.setPointerCapture(e.pointerId);
    const hit = this.nodeAt(x, y);
    if (hit) {
      this.dragNode = hit;
      this.reheat();
    } else {
      this.panning = true;
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const { x, y } = this.localXY(e);
    if (this.dragNode) {
      const w = this.toWorld(x, y);
      this.dragNode.x = w.x;
      this.dragNode.y = w.y;
      this.moved += Math.abs(x - this.downX) + Math.abs(y - this.downY);
      this.kick();
      return;
    }
    if (this.panning) {
      this.offsetX += x - this.downX;
      this.offsetY += y - this.downY;
      this.downX = x;
      this.downY = y;
      this.moved += CLICK_SLOP + 1;
      this.renderOnce();
      return;
    }
    // Hover highlighting.
    const hit = this.nodeAt(x, y);
    if (hit !== this.hover) {
      this.hover = hit;
      this.canvas.style.cursor = hit ? "pointer" : "default";
      this.renderOnce();
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const { x, y } = this.localXY(e);
    const click = this.moved < CLICK_SLOP;
    const node = this.dragNode;
    this.dragNode = null;
    this.panning = false;
    this.canvas.releasePointerCapture?.(e.pointerId);
    if (click) {
      const hit = node ?? this.nodeAt(x, y);
      if (hit) this.opts.onOpenFile(hit.path);
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { x, y } = this.localXY(e);
    const before = this.toWorld(x, y);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.scale = Math.min(4, Math.max(0.1, this.scale * factor));
    // Keep the point under the cursor fixed while zooming.
    this.offsetX = x - before.x * this.scale;
    this.offsetY = y - before.y * this.scale;
    this.renderOnce();
  };

  private onDblClick = () => {
    this.scale = 1;
    this.offsetX = this.canvas.clientWidth / 2;
    this.offsetY = this.canvas.clientHeight / 2;
    this.renderOnce();
  };
}
