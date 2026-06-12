import { renderDrawer, openDrawer, closeDrawer } from "./drawer.js";
import { renderGraph, renderTimeline } from "./graph.js";
import { renderLinkList } from "./links.js";
import type { ConsoleGate, ConsoleProjection } from "./types.js";

const THEME_STORAGE_KEY = "flow-console-theme";

function text(value: string, className?: string) {
  const node = document.createElement("span");
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function badge(value: string, modClass?: string) {
  const b = document.createElement("span");
  b.className = `badge${modClass ? ` ${modClass}` : ""}`;
  b.textContent = value;
  return b;
}

function getStatusClass(status: string | null) {
  if (!status) return "status-unknown";
  return `status-${status.replace(/\s+/g, "-").toLowerCase()}`;
}

function resolvedTheme(): "dark" | "light" {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: "dark" | "light") {
  const html = document.documentElement;
  html.setAttribute("data-theme", theme === "light" ? "light" : "dark");
}

function renderThemeToggle(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "theme-toggle";
  btn.setAttribute("aria-label", "Toggle light/dark theme");
  btn.setAttribute("title", "Toggle theme");

  const update = () => {
    const current = resolvedTheme();
    btn.textContent = current === "dark" ? "☀" : "☾";
    btn.setAttribute("aria-pressed", current === "dark" ? "false" : "true");
  };
  update();

  btn.addEventListener("click", () => {
    const next = resolvedTheme() === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
    update();
  });
  return btn;
}

function renderHeader(projection: ConsoleProjection) {
  const header = document.createElement("header");
  header.className = "console-header";

  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = projection.definition.title ?? projection.definition.description ?? "Flow Console";

  const subject = document.createElement("h1");
  subject.className = "header-subject";
  subject.textContent = projection.run.subject ?? projection.run.run_id;

  const statusRow = document.createElement("div");
  statusRow.className = "header-status-row";

  const statusBadge = document.createElement("span");
  const runStatus = projection.run.status ?? "unknown";
  statusBadge.className = `status-hero ${getStatusClass(runStatus)}`;
  statusBadge.dataset.testid = "flow-console-status";
  statusBadge.textContent = runStatus;

  const step = projection.steps.find((s) => s.id === projection.current_step);
  const stepLabel = step?.label ?? projection.current_step ?? "—";
  const stepSpan = document.createElement("span");
  stepSpan.className = "header-step";
  stepSpan.textContent = `at ${stepLabel}`;

  statusRow.append(statusBadge, stepSpan);

  const headerMain = document.createElement("div");
  headerMain.className = "header-main";
  headerMain.append(eyebrow, subject, statusRow);

  if (projection.next_action) {
    const nextAction = document.createElement("div");
    nextAction.className = "header-next-action";
    nextAction.append(text("Next: ", "next-label"), text(projection.next_action));
    headerMain.append(nextAction);
  }

  // Collapsed metadata row
  const metaDetails = document.createElement("details");
  metaDetails.className = "run-meta-details";
  const metaSummary = document.createElement("summary");
  metaSummary.textContent = "Run details";
  const metaGrid = document.createElement("dl");
  metaGrid.className = "run-meta-grid";

  const addMeta = (label: string, value: string | null | undefined) => {
    if (!value) return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    metaGrid.append(dt, dd);
  };

  addMeta("Run ID", projection.run.run_id);
  addMeta("Updated", projection.run.updated_at);
  addMeta("Continuation", projection.continuation);

  metaDetails.append(metaSummary, metaGrid);
  headerMain.append(metaDetails);

  const themeToggle = renderThemeToggle();

  header.append(headerMain, themeToggle);
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
  left.append(renderGraph(projection, (gate: ConsoleGate) => openDrawer(gate, projection)), renderTimeline(projection), renderLinks(projection));

  const drawer = renderDrawer(projection);
  main.append(left);
  root.append(main, drawer);
}

async function boot() {
  // Apply theme before rendering to avoid flash
  applyTheme(resolvedTheme());

  const root = document.querySelector<HTMLDivElement>("#app");
  try {
    const response = await fetch("/api/projection", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`projection request failed: ${response.status}`);
    renderApp((await response.json()) as ConsoleProjection);
  } catch (error) {
    if (root) {
      root.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "empty-state error-state";
      const icon = document.createElement("span");
      icon.className = "empty-icon";
      icon.textContent = "⚠";
      const msg = document.createElement("p");
      msg.className = "empty-message";
      msg.textContent = error instanceof Error ? error.message : String(error);
      const hint = document.createElement("p");
      hint.className = "empty-hint";
      hint.textContent = "flow console --run <run-id>  to retry with a valid run";
      wrap.append(icon, msg, hint);
      root.append(wrap);
    }
  }
}

void boot();
// expose closeDrawer for inline handler
(window as unknown as Record<string, unknown>).closeDrawer = closeDrawer;
