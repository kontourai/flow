// Shared, framework-free render primitives for Flow's console UI.
//
// These pure functions build DOM nodes from an ALREADY-DERIVED Flow console
// projection. They derive nothing about trust or process — every value shown is
// read straight off the projection the server produced. Both consumers share
// them so the render logic is written once:
//   - the loopback console page (`app.ts` / `graph.ts` / `drawer.ts`), and
//   - the dependency-free `<flow-run-panel>` custom element.
//
// Everything is rendered via `textContent` / DOM APIs (never innerHTML), so
// untrusted projection values are inert by construction — there is no HTML
// string interpolation to escape. The functions take an explicit `Document`
// (`doc`) so they work identically in the page's light DOM and the element's
// shadow root.

// ---------------------------------------------------------------------------
// Structural shapes — the read-only fields these renderers touch.
//
// Both the loopback `ConsoleProjection` (./types.ts) and the OWNED
// `FlowConsoleProjection` (../console/console-projection.ts) are assignable to
// these, so either can be passed without a coupling import.
// ---------------------------------------------------------------------------

export interface RenderStep {
  id: string;
  index: number;
  label: string;
  next: string | null;
  gates: string[];
}

export interface RenderGate {
  id: string;
  step_id: string;
  status: string;
  summary: string;
  is_open?: boolean;
  expectations: Array<{ id: string; description: string | null; required: boolean }>;
  evidence: RenderEvidence[];
  missing: string[];
  optional_missing: string[];
  route_back_to?: string;
  route_reason?: string;
  attempt?: number;
  max_attempts?: number;
  accepted_exception_id?: string;
}

export interface RenderEvidence {
  id: string;
  kind: string | null;
  status: string | null;
  producer: string | null;
  external_links: RenderLink[];
  bundle_report?: Record<string, unknown> | null;
}

export interface RenderLink {
  id: string;
  kind: string;
  label?: string;
  href?: string;
  path?: string;
  source: string;
  target_id?: string;
}

export interface RenderRouteBack {
  id: string;
  source: string;
  gate_id: string | null;
  from_step: string | null;
  to_step: string | null;
  route_back_to: string | null;
  reason: string | null;
  attempt: number | null;
  max_attempts: number | null;
  limit_exceeded: boolean;
  invalidated_steps: string[];
}

export interface RenderProjection {
  steps: RenderStep[];
  current_step: string | null;
  gates: RenderGate[];
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

export function statusClass(status: string | null | undefined): string {
  if (!status) return "status-unknown";
  return `status-${status.replace(/\s+/g, "-").toLowerCase()}`;
}

export function stepStatus(step: RenderStep, gates: RenderGate[]): string {
  const stepGates = gates.filter((gate) => gate.step_id === step.id);
  if (stepGates.some((gate) => gate.status === "block" || gate.status === "route-back")) return "block";
  if (stepGates.some((gate) => gate.status === "wait")) return "wait";
  if (stepGates.length && stepGates.every((gate) => gate.status === "pass")) return "pass";
  return "pending";
}

// ---------------------------------------------------------------------------
// Process graph (DAG): stage statuses + gate chips per step
// ---------------------------------------------------------------------------

export interface GraphCallbacks {
  /** Invoked when a node with a gate is activated (click / Enter / Space). */
  onNodeActivate?: (gate: RenderGate, projection: RenderProjection) => void;
}

export function renderGraph(
  doc: Document,
  projection: RenderProjection,
  callbacks: GraphCallbacks = {}
): HTMLElement {
  const graph = doc.createElement("section");
  graph.className = "graph";
  graph.dataset.testid = "flow-console-graph";
  graph.setAttribute("aria-label", "Flow graph");

  const nodes = doc.createElement("div");
  nodes.className = "graph-nodes";
  const gatesByStep = new Map(
    projection.steps.map((step) => [step.id, projection.gates.filter((gate) => gate.step_id === step.id)])
  );

  for (const step of projection.steps) {
    const node = doc.createElement("article");
    const current = step.id === projection.current_step;
    const status = stepStatus(step, projection.gates);
    node.className = `graph-node status-${status}${current ? " is-current" : ""}`;
    node.dataset.stepId = step.id;
    node.dataset.testid = "flow-console-node";

    const gates = gatesByStep.get(step.id) ?? [];
    const clickableGate = gates.find((g) => g.step_id === step.id) ?? gates[0];
    if (clickableGate && callbacks.onNodeActivate) {
      const activate = callbacks.onNodeActivate;
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      node.setAttribute(
        "aria-label",
        `${step.label}: ${clickableGate.id} (${clickableGate.status}) — activate for details`
      );
      const handle = () => activate(clickableGate, projection);
      node.addEventListener("click", handle);
      node.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handle();
        }
      });
    }

    const index = doc.createElement("span");
    index.className = "node-index";
    index.textContent = String(step.index + 1).padStart(2, "0");

    const title = doc.createElement("strong");
    title.textContent = step.label;

    const meta = doc.createElement("span");
    meta.className = "node-meta";
    meta.textContent = current ? "current" : step.next ? `next: ${step.next}` : "terminal";

    const gateLine = doc.createElement("span");
    gateLine.className = "node-gates";
    if (gates.length) {
      for (const gate of gates) {
        const chip = doc.createElement("span");
        chip.className = `node-gate-chip ${statusClass(gate.status)}`;
        chip.textContent = `${gate.id}: ${gate.status}`;
        gateLine.append(chip);
      }
    } else {
      gateLine.textContent = "no gate";
    }

    node.append(index, title, meta, gateLine);
    nodes.append(node);
  }

  graph.append(nodes);
  return graph;
}

// ---------------------------------------------------------------------------
// Gate checklist (expectations + which are missing)
// ---------------------------------------------------------------------------

export function renderGateChecklist(doc: Document, gate: RenderGate): HTMLElement {
  const section = doc.createElement("section");
  section.className = "drawer-section";
  const title = doc.createElement("h3");
  title.className = "drawer-section-title";
  title.textContent = "What this gate needs";
  section.append(title);

  if (!gate.expectations.length) {
    const none = doc.createElement("p");
    none.className = "drawer-empty";
    none.textContent = "No expectations defined.";
    section.append(none);
    return section;
  }

  const list = doc.createElement("ul");
  list.className = "checklist";
  for (const exp of gate.expectations) {
    const isMissing = gate.missing.includes(exp.id) || gate.optional_missing.includes(exp.id);
    const item = doc.createElement("li");
    item.className = `checklist-item ${isMissing ? "checklist-missing" : "checklist-met"}`;

    const check = doc.createElement("span");
    check.className = "checklist-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = isMissing ? "✗" : "✓";

    const label = doc.createElement("span");
    label.className = "checklist-label";
    label.textContent = exp.description ?? exp.id;

    item.append(check, label);
    if (!exp.required) {
      const optBadge = doc.createElement("span");
      optBadge.className = "badge badge-neutral";
      optBadge.textContent = "optional";
      item.append(optBadge);
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

// ---------------------------------------------------------------------------
// Evidence rows (incl. nested <surface-trust-panel> when a bundle_report
// is present — Flow hands Surface its pre-derived report, never re-derives)
// ---------------------------------------------------------------------------

export interface EvidenceOptions {
  /** Render a link list for an evidence row's external links. */
  renderLinks?: (doc: Document, links: RenderLink[]) => HTMLElement;
  /** Bridge the host palette onto a nested <surface-trust-panel>. */
  themeTrustPanel?: (panel: HTMLElement) => void;
}

function badge(doc: Document, value: string, modClass?: string): HTMLElement {
  const b = doc.createElement("span");
  b.className = `badge${modClass ? ` badge-${modClass}` : ""}`;
  b.textContent = value;
  return b;
}

export function renderEvidenceSection(
  doc: Document,
  gate: RenderGate,
  options: EvidenceOptions = {}
): HTMLElement {
  const section = doc.createElement("section");
  section.className = "drawer-section";
  const title = doc.createElement("h3");
  title.className = "drawer-section-title";
  title.textContent = "Evidence";
  section.append(title);

  if (!gate.evidence.length) {
    const none = doc.createElement("p");
    none.className = "drawer-empty";
    none.textContent = "No evidence attached.";
    section.append(none);
    return section;
  }

  for (const ev of gate.evidence) {
    const row = doc.createElement("article");
    row.className = "evidence-row";

    const head = doc.createElement("div");
    head.className = "evidence-head";

    const idSpan = doc.createElement("strong");
    idSpan.className = "evidence-id";
    idSpan.textContent = ev.id;

    const badges = doc.createElement("span");
    badges.className = "evidence-badges";
    if (ev.kind) badges.append(badge(doc, ev.kind, "kind"));
    if (ev.status) badges.append(badge(doc, ev.status, statusClass(ev.status).replace(/^status-/, "")));
    if (ev.producer) badges.append(badge(doc, ev.producer, "producer"));

    head.append(idSpan, badges);
    row.append(head);

    if (ev.external_links?.length && options.renderLinks) {
      row.append(options.renderLinks(doc, ev.external_links));
    }

    // Nested Surface trust panel — read-only by reference. When the evidence
    // carries a pre-derived TrustReport, mount Surface's own element and hand it
    // the already-derived report. Flow does NOT re-derive or re-style trust
    // here. Degrades gracefully: an unregistered custom element renders empty
    // and setting `.report` is harmless.
    if (ev.bundle_report) {
      const panel = doc.createElement("surface-trust-panel") as HTMLElement & { report?: unknown };
      panel.className = "evidence-trust-panel";
      panel.setAttribute("heading", "Trust report");
      options.themeTrustPanel?.(panel);
      panel.report = ev.bundle_report;
      row.append(panel);
    }

    section.append(row);
  }
  return section;
}

// ---------------------------------------------------------------------------
// Route callout for a single gate (route-back target + reason + attempt)
// ---------------------------------------------------------------------------

export function renderRouteCallout(doc: Document, gate: RenderGate): HTMLElement | null {
  if (!gate.route_reason && !gate.route_back_to) return null;
  const callout = doc.createElement("div");
  callout.className = "route-callout";
  if (gate.route_back_to) {
    const routeTitle = doc.createElement("strong");
    routeTitle.textContent = `Route back to ${gate.route_back_to}`;
    callout.append(routeTitle);
  }
  if (gate.route_reason) {
    const reason = doc.createElement("p");
    reason.className = "route-reason clamped-text";
    reason.textContent = gate.route_reason;
    callout.append(reason);
  }
  if (gate.attempt) {
    const attemptNote = doc.createElement("span");
    attemptNote.className = "route-attempt";
    attemptNote.textContent = `Attempt ${gate.attempt} of ${gate.max_attempts ?? "?"}`;
    callout.append(attemptNote);
  }
  return callout;
}

// ---------------------------------------------------------------------------
// Route-backs section — the run-level cascade view, incl. invalidated_steps.
// (Panel-specific; the loopback page surfaces routing per-gate in the drawer.)
// ---------------------------------------------------------------------------

export function renderRouteBacks(doc: Document, routeBacks: RenderRouteBack[]): HTMLElement {
  const section = doc.createElement("section");
  section.className = "route-backs";
  section.dataset.testid = "flow-console-route-backs";

  const title = doc.createElement("h2");
  title.className = "section-title";
  title.textContent = "Route-backs";
  section.append(title);

  if (!routeBacks.length) {
    const none = doc.createElement("p");
    none.className = "drawer-empty";
    none.textContent = "No route-backs.";
    section.append(none);
    return section;
  }

  for (const rb of routeBacks) {
    const row = doc.createElement("article");
    row.className = "route-back-row";
    row.dataset.routeBackId = rb.id;
    row.dataset.source = rb.source;

    const head = doc.createElement("div");
    head.className = "route-back-head";

    const route = doc.createElement("span");
    route.className = "route-back-route";
    route.textContent = `${rb.from_step ?? rb.gate_id ?? "gate"} → ${rb.route_back_to ?? rb.to_step ?? "?"}`;
    head.append(route);

    if (rb.attempt) {
      const attempt = doc.createElement("span");
      attempt.className = "route-back-attempt";
      attempt.textContent = `attempt ${rb.attempt}/${rb.max_attempts ?? "?"}`;
      head.append(attempt);
    }
    if (rb.limit_exceeded) {
      const limit = doc.createElement("span");
      limit.className = "badge badge-block";
      limit.textContent = "limit exceeded";
      head.append(limit);
    }
    row.append(head);

    if (rb.reason) {
      const reason = doc.createElement("p");
      reason.className = "route-back-reason clamped-text";
      reason.textContent = rb.reason;
      row.append(reason);
    }

    if (rb.invalidated_steps.length) {
      const invalidated = doc.createElement("div");
      invalidated.className = "route-back-invalidated";
      invalidated.dataset.testid = "route-back-invalidated";

      const label = doc.createElement("span");
      label.className = "route-back-invalidated-label";
      label.textContent = "Invalidated steps:";
      invalidated.append(label);

      const chips = doc.createElement("span");
      chips.className = "route-back-invalidated-chips";
      for (const step of rb.invalidated_steps) {
        const chip = doc.createElement("span");
        chip.className = "badge badge-wait";
        chip.dataset.invalidatedStep = step;
        chip.textContent = step;
        chips.append(chip);
      }
      invalidated.append(chips);
      row.append(invalidated);
    }

    section.append(row);
  }
  return section;
}

// ---------------------------------------------------------------------------
// Next action banner
// ---------------------------------------------------------------------------

export function renderNextAction(doc: Document, nextAction: string | null): HTMLElement | null {
  if (!nextAction) return null;
  const banner = doc.createElement("div");
  banner.className = "next-action";
  banner.dataset.testid = "flow-console-next-action";

  const label = doc.createElement("span");
  label.className = "next-label";
  label.textContent = "Next: ";

  const value = doc.createElement("span");
  value.className = "next-action-value";
  value.textContent = nextAction;

  banner.append(label, value);
  return banner;
}
