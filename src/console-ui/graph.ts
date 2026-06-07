import type { ConsoleGate, ConsoleProjection, ConsoleStep } from "./types.js";

function statusForStep(step: ConsoleStep, gates: ConsoleGate[]) {
  const stepGates = gates.filter((gate) => gate.step_id === step.id);
  if (stepGates.some((gate) => gate.status === "block" || gate.status === "route-back")) return "block";
  if (stepGates.some((gate) => gate.status === "wait")) return "wait";
  if (stepGates.length && stepGates.every((gate) => gate.status === "pass")) return "pass";
  return "pending";
}

export function renderGraph(projection: ConsoleProjection) {
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
    node.className = `graph-node status-${statusForStep(step, projection.gates)}${current ? " is-current" : ""}`;
    node.dataset.stepId = step.id;
    node.dataset.testid = "flow-console-node";
    const index = document.createElement("span");
    index.className = "node-index";
    index.textContent = String(step.index + 1).padStart(2, "0");
    const title = document.createElement("strong");
    title.textContent = step.label;
    const meta = document.createElement("span");
    meta.textContent = current ? "current" : step.next ? `next ${step.next}` : "terminal";
    const gateLine = document.createElement("span");
    gateLine.className = "node-gates";
    const gates = gatesByStep.get(step.id) ?? [];
    gateLine.textContent = gates.length ? gates.map((gate) => `${gate.id}: ${gate.status}`).join(" | ") : "no gate";
    node.append(index, title, meta, gateLine);
    nodes.append(node);
  }

  const edges = document.createElement("div");
  edges.className = "graph-edges";
  edges.dataset.testid = "flow-console-edges";
  for (const transition of projection.transitions) {
    const row = document.createElement("div");
    row.className = `edge-row status-${transition.status ?? "unknown"}`;
    row.textContent = `${transition.from_step ?? "start"} -> ${transition.to_step ?? "end"} | ${transition.status ?? transition.type}`;
    edges.append(row);
  }

  graph.append(nodes, edges);
  return graph;
}

export function renderTimeline(projection: ConsoleProjection) {
  const timeline = document.createElement("section");
  timeline.className = "timeline";
  timeline.dataset.testid = "flow-console-timeline";
  for (const transition of projection.transitions) {
    const row = document.createElement("article");
    row.className = "timeline-row";
    const at = document.createElement("time");
    at.textContent = transition.at ?? "no timestamp";
    const body = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = `${transition.from_step ?? "start"} -> ${transition.to_step ?? "end"}`;
    const detail = document.createElement("span");
    detail.textContent = transition.reason ?? transition.route_reason ?? transition.type;
    body.append(label, detail);
    const status = document.createElement("span");
    status.className = `status-pill status-${transition.status ?? "unknown"}`;
    status.textContent = transition.status ?? transition.type;
    row.append(at, body, status);
    timeline.append(row);
  }
  return timeline;
}
