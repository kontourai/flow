// <flow-run-panel> — a dependency-free, read-only Flow run panel custom element.
//
// Renders an ALREADY-DERIVED Flow console projection (the output of
// `projectFlowRunFromFiles` / `projectFlowRun`, exported as
// `FlowConsoleProjection` from `@kontourai/flow/console-contract`) so a viewer
// can inspect a run's process graph, gates, evidence, route-backs (incl. the
// invalidated downstream steps), and next action. The element never mutates or
// re-derives process or trust state; it only displays what Flow's projector
// derived server-side. Authority stays with Flow (process) and Surface (trust).
//
// This is a self-contained ES module with no framework runtime and no imports
// except Flow's own pure render-core (bundled at build time). Its only global
// side effect is the `customElements.define` (guarded against double
// registration), so it drops cleanly into a React tree as a custom element.
//
// Usage:
//   import "@kontourai/flow/flow-run-panel/element"; // registers the element
//   const el = document.createElement("flow-run-panel");
//   el.projection = flowConsoleProjection; // pre-derived FlowConsoleProjection
//   document.body.append(el);
//
// Theming: inherits the host via CSS custom properties (matching
// <surface-trust-panel> token names where they overlap): --k-text,
// --k-text-muted, --k-panel, --k-panel-raised, --k-line, --k-positive,
// --k-caution, --k-negative, --k-active, --k-font-ui.
import {
  renderGraph,
  renderGateChecklist,
  renderEvidenceSection,
  renderRouteCallout,
  renderRouteBacks,
  renderNextAction,
  statusClass,
  type RenderGate,
  type RenderProjection,
  type RenderRouteBack
} from "./render-core.js";

// The element accepts the OWNED FlowConsoleProjection. The structural shapes in
// render-core are assignable from it, so we type the property loosely here
// (the element derives nothing — it only reads documented fields).
type FlowConsoleProjectionLike = RenderProjection & {
  run?: {
    run_id?: string | null;
    subject?: string | null;
    status?: string | null;
    current_step?: string | null;
    updated_at?: string | null;
  };
  definition?: { title?: string | null; description?: string | null };
  route_backs?: RenderRouteBack[];
  next_action?: string | null;
};

const PANEL_CSS = `
:host {
  display: block;
  font-family: var(--k-font-ui, system-ui, sans-serif);
  color: var(--k-text, #17201b);
  line-height: 1.5;
  --fp-pass: var(--k-positive, #0f8f66);
  --fp-block: var(--k-negative, #c24141);
  --fp-wait: var(--k-caution, #a86612);
  --fp-current: var(--k-active, #2f8f7a);
  --fp-line: var(--k-line, rgba(36, 68, 52, 0.16));
  --fp-panel: var(--k-panel, #fffcf1);
  --fp-raised: var(--k-panel-raised, #fbf6e7);
  --fp-muted: var(--k-text-muted, #657267);
}
* { box-sizing: border-box; }
.panel {
  border: 1px solid var(--fp-line);
  border-radius: 16px;
  background: var(--fp-panel);
  padding: 1rem;
}
.panel-header { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; align-items: baseline; }
.panel-title { margin: 0; font-size: 1.05rem; font-weight: 700; overflow-wrap: anywhere; }
.panel-meta { margin: 0; color: var(--fp-muted); font-size: 0.82rem; overflow-wrap: anywhere; }
.status-hero {
  display: inline-block;
  border-radius: 999px;
  padding: 0.15rem 0.6rem;
  font-size: 0.78rem;
  font-weight: 700;
  border: 1px solid var(--fp-line);
  background: var(--fp-raised);
}
.section-title, .drawer-section-title {
  margin: 1rem 0 0.4rem;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fp-muted);
}
.next-action {
  margin: 0.6rem 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--fp-line);
  border-radius: 12px;
  background: var(--fp-raised);
  font-size: 0.9rem;
}
.next-label { color: var(--fp-muted); font-weight: 600; }

/* Process graph (DAG) */
.graph-nodes { display: flex; flex-wrap: wrap; gap: 0.6rem; margin: 0.4rem 0 0.8rem; }
.graph-node {
  flex: 1 1 9rem;
  min-width: 9rem;
  border: 1px solid var(--fp-line);
  border-radius: 12px;
  padding: 0.5rem 0.65rem;
  background: var(--fp-raised);
  display: grid;
  gap: 0.2rem;
}
.graph-node[role="button"] { cursor: pointer; }
.graph-node.is-current { outline: 2px solid var(--fp-current); outline-offset: 1px; }
.graph-node.status-pass { border-left: 3px solid var(--fp-pass); }
.graph-node.status-block { border-left: 3px solid var(--fp-block); }
.graph-node.status-wait { border-left: 3px solid var(--fp-wait); }
.node-index { font-size: 0.7rem; color: var(--fp-muted); letter-spacing: 0.1em; }
.node-meta { font-size: 0.74rem; color: var(--fp-muted); }
.node-gates { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.2rem; }
.node-gate-chip {
  font-size: 0.7rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  border: 1px solid var(--fp-line);
}

/* Gates / drawer sections */
.drawer-section { margin-top: 0.4rem; }
.checklist { list-style: none; margin: 0.2rem 0; padding: 0; }
.checklist-item { display: flex; gap: 0.4rem; align-items: baseline; font-size: 0.85rem; margin: 0.2rem 0; }
.checklist-check { font-weight: 700; }
.checklist-missing .checklist-check { color: var(--fp-block); }
.checklist-met .checklist-check { color: var(--fp-pass); }
.gate-block {
  border: 1px solid var(--fp-line);
  border-radius: 12px;
  padding: 0.6rem 0.75rem;
  margin: 0.5rem 0;
  background: var(--fp-raised);
}
.gate-block-head { display: flex; flex-wrap: wrap; gap: 0.4rem 0.6rem; align-items: center; }
.gate-block-title { font-weight: 700; overflow-wrap: anywhere; }
.gate-summary { font-size: 0.85rem; color: var(--fp-muted); overflow-wrap: anywhere; }

/* Evidence */
.evidence-row {
  border: 1px solid var(--fp-line);
  border-radius: 10px;
  padding: 0.45rem 0.6rem;
  margin: 0.4rem 0;
  background: var(--fp-panel);
}
.evidence-head { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
.evidence-id { overflow-wrap: anywhere; }
.evidence-badges { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.badge {
  font-size: 0.72rem;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  border: 1px solid var(--fp-line);
  background: var(--fp-raised);
}
.badge-block, .badge-route-back { color: var(--fp-block); }
.badge-wait { color: var(--fp-wait); }
.badge-pass { color: var(--fp-pass); }
.evidence-trust-panel { display: block; margin-top: 0.5rem; }

/* Links */
.link-list { list-style: none; margin: 0.3rem 0; padding: 0; display: grid; gap: 0.25rem; }
.link-list li { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: baseline; font-size: 0.82rem; }
.link-list .kind {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fp-muted);
  border: 1px solid var(--fp-line);
  border-radius: 999px;
  padding: 0.02rem 0.4rem;
}
.link-list a { color: var(--fp-current); overflow-wrap: anywhere; }
.link-list .disabled-link { color: var(--fp-muted); }
.link-list small { color: var(--fp-muted); overflow-wrap: anywhere; }

/* Route callout / route-backs */
.route-callout, .route-back-row {
  border: 1px solid var(--fp-line);
  border-radius: 12px;
  padding: 0.5rem 0.65rem;
  margin: 0.4rem 0;
  background: var(--fp-raised);
}
.route-callout strong, .route-back-route { color: var(--fp-block); font-weight: 700; }
.route-reason, .route-back-reason { margin: 0.3rem 0 0; font-size: 0.85rem; overflow-wrap: anywhere; }
.route-attempt, .route-back-attempt { font-size: 0.78rem; color: var(--fp-muted); }
.route-back-head { display: flex; flex-wrap: wrap; gap: 0.4rem 0.6rem; align-items: center; }
.route-back-invalidated {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: baseline;
  margin-top: 0.4rem;
}
.route-back-invalidated-label { font-size: 0.78rem; color: var(--fp-muted); font-weight: 600; }
.route-back-invalidated-chips { display: flex; flex-wrap: wrap; gap: 0.25rem; }

.drawer-empty, .empty { color: var(--fp-muted); font-size: 0.85rem; }
.footnote { margin: 0.9rem 0 0; color: var(--fp-muted); font-size: 0.75rem; }
`;

class FlowRunPanel extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["heading"];
  }

  #projection: FlowConsoleProjectionLike | null = null;
  #shadow: ShadowRoot;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: "open" });
  }

  connectedCallback(): void {
    // Re-apply a `projection` set before the element was upgraded, so the
    // property assignment reaches the class accessor instead of being shadowed
    // by an own property (mirrors <surface-trust-panel>).
    if (Object.prototype.hasOwnProperty.call(this, "projection")) {
      const pending = (this as unknown as { projection: unknown }).projection;
      delete (this as unknown as { projection?: unknown }).projection;
      this.projection = pending as FlowConsoleProjectionLike | null;
      return;
    }
    this.#render();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === "heading" && newValue !== oldValue) this.#render();
  }

  get projection(): FlowConsoleProjectionLike | null {
    return this.#projection;
  }

  set projection(value: FlowConsoleProjectionLike | null) {
    this.#projection = value ?? null;
    this.#render();
  }

  #render(): void {
    const doc = this.ownerDocument;
    const projection = this.#projection;

    const panel = doc.createElement("div");
    panel.className = "panel";

    if (!projection) {
      const empty = doc.createElement("p");
      empty.className = "empty";
      empty.textContent = "No Flow run projection loaded yet.";
      panel.append(empty);
      this.#mount(panel);
      return;
    }

    if (!Array.isArray(projection.steps) || !Array.isArray(projection.gates)) {
      const err = doc.createElement("p");
      err.className = "empty";
      err.textContent = "This JSON does not look like a Flow console projection: no steps/gates.";
      panel.append(err);
      this.#mount(panel);
      return;
    }

    panel.append(this.#renderHeader(doc, projection));

    const next = renderNextAction(doc, projection.next_action ?? null);
    if (next) panel.append(next);

    // Process graph (read-only — no node-activate callback; the panel shows the
    // full run at once rather than a drilldown drawer).
    panel.append(renderGraph(doc, projection));

    panel.append(this.#renderGates(doc, projection.gates));

    panel.append(renderRouteBacks(doc, projection.route_backs ?? []));

    const footnote = doc.createElement("p");
    footnote.className = "footnote";
    footnote.textContent =
      "Read-only. Process state is derived by Kontour Flow; trust state by Kontour Surface — this panel renders the pre-derived projection.";
    panel.append(footnote);

    this.#mount(panel);
  }

  #renderHeader(doc: Document, projection: FlowConsoleProjectionLike): HTMLElement {
    const header = doc.createElement("div");
    header.className = "panel-header";

    const heading = this.getAttribute("heading");
    const title = doc.createElement("p");
    title.className = "panel-title";
    title.textContent =
      heading ?? projection.run?.subject ?? projection.run?.run_id ?? projection.definition?.title ?? "Flow Run";
    header.append(title);

    const status = projection.run?.status;
    if (status) {
      const badge = doc.createElement("span");
      badge.className = `status-hero ${statusClass(status)}`;
      badge.dataset.testid = "flow-run-panel-status";
      badge.textContent = status;
      header.append(badge);
    }

    const meta = doc.createElement("p");
    meta.className = "panel-meta";
    const parts: string[] = [];
    if (projection.run?.run_id) parts.push(projection.run.run_id);
    if (projection.run?.current_step) parts.push(`at ${projection.run.current_step}`);
    if (projection.run?.updated_at) parts.push(projection.run.updated_at);
    meta.textContent = parts.join(" · ");
    if (meta.textContent) header.append(meta);

    return header;
  }

  #renderGates(doc: Document, gates: RenderGate[]): HTMLElement {
    const section = doc.createElement("section");
    section.className = "gates";
    section.dataset.testid = "flow-run-panel-gates";

    const title = doc.createElement("h2");
    title.className = "section-title";
    title.textContent = "Gates";
    section.append(title);

    if (!gates.length) {
      const none = doc.createElement("p");
      none.className = "drawer-empty";
      none.textContent = "No gates defined.";
      section.append(none);
      return section;
    }

    for (const gate of gates) {
      const block = doc.createElement("article");
      block.className = "gate-block";
      block.dataset.gateId = gate.id;
      block.dataset.testid = "flow-run-panel-gate";

      const head = doc.createElement("div");
      head.className = "gate-block-head";

      const status = doc.createElement("span");
      status.className = `status-hero ${statusClass(gate.status)}`;
      status.textContent = gate.status;

      const gateTitle = doc.createElement("span");
      gateTitle.className = "gate-block-title";
      gateTitle.textContent = `${gate.id} (${gate.step_id})`;

      head.append(status, gateTitle);
      block.append(head);

      if (gate.summary) {
        const summary = doc.createElement("p");
        summary.className = "gate-summary";
        summary.textContent = gate.summary;
        block.append(summary);
      }

      const routeCallout = renderRouteCallout(doc, gate);
      if (routeCallout) block.append(routeCallout);

      block.append(renderGateChecklist(doc, gate));
      // Evidence rows + nested <surface-trust-panel> for pre-derived reports.
      // The nested panel inherits the same --k-* tokens by cascade through the
      // shadow boundary, so no explicit palette bridge is needed here.
      block.append(renderEvidenceSection(doc, gate, { renderLinks: renderLinkList }));

      section.append(block);
    }

    return section;
  }

  #mount(panel: HTMLElement): void {
    const style = this.ownerDocument.createElement("style");
    style.textContent = PANEL_CSS;
    this.#shadow.replaceChildren(style, panel);
  }
}

// Minimal, dependency-free link list for evidence external links. The loopback
// page has a richer companion-aware renderer (links.ts); the embeddable element
// stays self-contained and only surfaces hrefs that are already absolute http(s)
// (it does not know the console's artifact/companion origins).
function renderLinkList(
  doc: Document,
  links: Array<{ id: string; kind: string; label?: string; href?: string; path?: string }>
): HTMLElement {
  const list = doc.createElement("ul");
  list.className = "link-list";
  for (const link of links) {
    const item = doc.createElement("li");
    item.dataset.linkKind = link.kind;
    item.dataset.linkId = link.id;

    const kind = doc.createElement("span");
    kind.className = "kind";
    kind.textContent = link.kind;

    const safeHref =
      link.href && (link.href.startsWith("http://") || link.href.startsWith("https://")) ? link.href : undefined;
    const body = doc.createElement(safeHref ? "a" : "span");
    body.textContent = link.label ?? link.id;
    if (safeHref && body instanceof HTMLAnchorElement) {
      body.href = safeHref;
      body.rel = "noreferrer noopener";
    } else {
      body.className = "disabled-link";
    }

    const detail = doc.createElement("small");
    detail.textContent = safeHref ? "" : link.path ? `reference: ${link.path}` : "reference only";

    item.append(kind, body, detail);
    list.append(item);
  }
  return list;
}

// Idempotent registration: only the FIRST module evaluation defines the element.
// Re-importing (or loading the module twice) is a no-op rather than a
// "this name has already been used" DOMException.
if (typeof customElements !== "undefined" && !customElements.get("flow-run-panel")) {
  customElements.define("flow-run-panel", FlowRunPanel);
}

export { FlowRunPanel };
