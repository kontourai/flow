import { renderGatePanel } from "./gates.js";
import { renderGraph, renderTimeline } from "./graph.js";
import { renderLinkList } from "./links.js";
import type { ConsoleProjection } from "./types.js";

function text(value: string, className?: string) {
  const node = document.createElement("span");
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function currentStatus(projection: ConsoleProjection) {
  const step = projection.steps.find((entry) => entry.id === projection.current_step);
  const stepLabel = step?.label ?? projection.current_step ?? "unknown";
  const status = projection.run.status ?? "unknown";
  const next = projection.next_action ? ` Next action: ${projection.next_action}` : "";
  return `${projection.run.run_id} is ${status} at ${stepLabel}.${next}`;
}

function renderHeader(projection: ConsoleProjection) {
  const header = document.createElement("header");
  header.className = "console-header";
  const title = document.createElement("div");
  title.append(text(projection.definition.title ?? projection.definition.description ?? "Flow Console", "eyebrow"));
  const status = document.createElement("h1");
  status.dataset.testid = "flow-console-status";
  status.textContent = currentStatus(projection);
  title.append(status);
  const meta = document.createElement("div");
  meta.className = "run-meta";
  meta.append(text(projection.run.subject ?? "no subject"), text(projection.continuation), text(projection.run.updated_at ?? "no update time"));
  header.append(title, meta);
  return header;
}

function renderLinks(projection: ConsoleProjection) {
  const section = document.createElement("section");
  section.className = "links-panel";
  section.dataset.testid = "flow-console-links";
  const title = document.createElement("h2");
  title.textContent = "Links";
  section.append(title, renderLinkList(projection.external_links));
  return section;
}

function renderApp(projection: ConsoleProjection) {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) return;
  document.title = `${projection.run.run_id} | Flow Console`;
  root.replaceChildren();
  root.append(renderHeader(projection));

  const main = document.createElement("main");
  main.className = "console-layout";
  const left = document.createElement("div");
  left.className = "primary-flow";
  left.append(renderGraph(projection), renderTimeline(projection), renderLinks(projection));
  main.append(left, renderGatePanel(projection.gates, projection.current_step));
  root.append(main);
}

async function boot() {
  const root = document.querySelector<HTMLDivElement>("#app");
  try {
    const response = await fetch("/api/projection", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`projection request failed: ${response.status}`);
    renderApp((await response.json()) as ConsoleProjection);
  } catch (error) {
    if (root) {
      root.innerHTML = "";
      const message = document.createElement("p");
      message.className = "error";
      message.textContent = error instanceof Error ? error.message : String(error);
      root.append(message);
    }
  }
}

void boot();
