import type { ConsoleGate, ConsoleProjection, ConsoleStep } from "./types.js";

// ---------------------------------------------------------------------------
// Timeline state — preserved across live re-renders
// ---------------------------------------------------------------------------
let _timelineExpanded = false;

export function isTimelineExpanded(): boolean {
  return _timelineExpanded;
}

export function setTimelineExpanded(value: boolean): void {
  _timelineExpanded = value;
}

function statusForStep(step: ConsoleStep, gates: ConsoleGate[]) {
  const stepGates = gates.filter((gate) => gate.step_id === step.id);
  if (stepGates.some((gate) => gate.status === "block" || gate.status === "route-back")) return "block";
  if (stepGates.some((gate) => gate.status === "wait")) return "wait";
  if (stepGates.length && stepGates.every((gate) => gate.status === "pass")) return "pass";
  return "pending";
}

function relativeTime(isoAt: string | null): string {
  if (!isoAt) return "";
  const ms = Date.now() - new Date(isoAt).getTime();
  if (isNaN(ms)) return "";
  const s = Math.floor(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function renderGraph(projection: ConsoleProjection, onNodeClick: (gate: ConsoleGate, projection: ConsoleProjection) => void) {
  const graph = document.createElement("section");
  graph.className = "graph";
  graph.dataset.testid = "flow-console-graph";
  graph.setAttribute("aria-label", "Flow graph");

  const nodes = document.createElement("div");
  nodes.className = "graph-nodes";
  const gatesByStep = new Map(projection.steps.map((step) => [step.id, projection.gates.filter((gate) => gate.step_id === step.id)]));

  for (const step of projection.steps) {
    const node = document.createElement("article");
    const current = step.id === projection.current_step;
    const stepStatus = statusForStep(step, projection.gates);
    node.className = `graph-node status-${stepStatus}${current ? " is-current" : ""}`;
    node.dataset.stepId = step.id;
    node.dataset.testid = "flow-console-node";

    const gates = gatesByStep.get(step.id) ?? [];
    const clickableGate = gates.find((g) => g.step_id === step.id) ?? gates[0];
    if (clickableGate) {
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      node.setAttribute("aria-label", `${step.label}: ${clickableGate.id} (${clickableGate.status}) — click for details`);
      const handleClick = () => onNodeClick(clickableGate, projection);
      node.addEventListener("click", handleClick);
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      });
    }

    const index = document.createElement("span");
    index.className = "node-index";
    index.textContent = String(step.index + 1).padStart(2, "0");

    const title = document.createElement("strong");
    title.textContent = step.label;

    const meta = document.createElement("span");
    meta.className = "node-meta";
    meta.textContent = current ? "current" : step.next ? `next: ${step.next}` : "terminal";

    const gateLine = document.createElement("span");
    gateLine.className = "node-gates";
    if (gates.length) {
      for (const gate of gates) {
        const g = document.createElement("span");
        g.className = `node-gate-chip status-${gate.status.replace(/\s+/g, "-").toLowerCase()}`;
        g.textContent = `${gate.id}: ${gate.status}`;
        gateLine.append(g);
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

export function renderTimeline(projection: ConsoleProjection) {
  const timeline = document.createElement("section");
  timeline.className = "timeline";
  timeline.dataset.testid = "flow-console-timeline";

  const transitions = projection.transitions;
  const SHOW_INITIAL = 5;
  const hasMore = transitions.length > SHOW_INITIAL;
  const initial = hasMore ? transitions.slice(-SHOW_INITIAL) : transitions;

  if (transitions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "drawer-empty timeline-empty";
    empty.textContent = "No transitions yet.";
    timeline.append(empty);
    return timeline;
  }

  const list = document.createElement("div");
  list.className = "timeline-list";

  const allRows: HTMLElement[] = [];

  for (const transition of transitions) {
    const row = document.createElement("article");
    row.className = "timeline-row";
    row.dataset.transitionId = transition.id;

    const statusPill = document.createElement("span");
    statusPill.className = `status-pill status-${(transition.status ?? transition.type).replace(/\s+/g, "-")}`;
    statusPill.textContent = transition.status ?? transition.type;

    const route = document.createElement("span");
    route.className = "timeline-route";
    route.textContent = `${transition.from_step ?? "start"} → ${transition.to_step ?? "end"}`;

    const rel = document.createElement("time");
    rel.className = "timeline-time";
    rel.textContent = relativeTime(transition.at);
    if (transition.at) rel.setAttribute("datetime", transition.at);

    const head = document.createElement("div");
    head.className = "timeline-head";
    head.append(statusPill, route, rel);
    row.append(head);

    const reason = transition.reason ?? transition.route_reason;
    if (reason) {
      const reasonEl = document.createElement("div");
      reasonEl.className = "timeline-reason clamped-text";
      reasonEl.textContent = reason;
      row.append(reasonEl);
    }

    allRows.push(row);
    list.append(row);
  }

  if (hasMore) {
    // Use persisted expanded state across re-renders
    const hiddenRows = allRows.slice(0, allRows.length - SHOW_INITIAL);

    if (_timelineExpanded) {
      // Already expanded from a previous render — show all rows immediately
      // (no button needed)
    } else {
      for (const r of hiddenRows) r.classList.add("timeline-hidden");

      const showAllBtn = document.createElement("button");
      showAllBtn.className = "show-all-btn";
      showAllBtn.textContent = `Show all (${transitions.length})`;
      showAllBtn.addEventListener("click", () => {
        _timelineExpanded = true;
        for (const r of hiddenRows) r.classList.remove("timeline-hidden");
        showAllBtn.remove();
      });
      timeline.append(showAllBtn);
    }
  }

  timeline.append(list);
  return timeline;
}
