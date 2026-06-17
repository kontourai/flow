import { renderLinkList } from "./links.js";
import {
  renderGateChecklist as renderGateChecklistCore,
  renderEvidenceSection as renderEvidenceSectionCore,
  renderRouteCallout as renderRouteCalloutCore
} from "./render-core.js";
import type { ConsoleGate, ConsoleProjection } from "./types.js";

let _currentProjection: ConsoleProjection | null = null;
let _drawerEl: HTMLElement | null = null;
let _openGateId: string | null = null;

// ---------------------------------------------------------------------------
// State accessors for live-update restore
// ---------------------------------------------------------------------------

export function getOpenGateId(): string | null {
  return _openGateId;
}

export function isDrawerOpen(): boolean {
  return Boolean(_drawerEl && _drawerEl.classList.contains("drawer-open"));
}

export function getDrawerScrollTop(): number {
  if (!_drawerEl) return 0;
  const body = _drawerEl.querySelector<HTMLElement>(".drawer-body");
  return body ? body.scrollTop : 0;
}

export function setDrawerScrollTop(value: number): void {
  if (!_drawerEl) return;
  const body = _drawerEl.querySelector<HTMLElement>(".drawer-body");
  if (body) body.scrollTop = value;
}

function clampedText(text: string, className: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `clamped ${className}`;
  const p = document.createElement("p");
  p.className = "clamped-text";
  p.textContent = text;

  if (text.length > 120) {
    const more = document.createElement("button");
    more.className = "clamp-toggle";
    more.textContent = "more";
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const expanded = p.classList.toggle("clamped-expanded");
      more.textContent = expanded ? "less" : "more";
      more.setAttribute("aria-expanded", String(expanded));
    });
    wrapper.append(p, more);
  } else {
    wrapper.append(p);
  }
  return wrapper;
}

function getStatusClass(status: string | null | undefined) {
  if (!status) return "status-unknown";
  return `status-${status.replace(/\s+/g, "-").toLowerCase()}`;
}

function renderGateChecklist(gate: ConsoleGate): HTMLElement {
  // Shared render-core builds the checklist (expectations + missing markers).
  return renderGateChecklistCore(document, gate);
}

function renderEvidenceSection(gate: ConsoleGate): HTMLElement {
  // Shared render-core builds evidence rows and mounts the nested
  // <surface-trust-panel> for any pre-derived bundle_report. The page injects
  // its own link renderer and palette bridge.
  return renderEvidenceSectionCore(document, gate, {
    // The page's link renderer narrows kind to ConsoleLink["kind"]; the console
    // projection only ever produces those kinds, so the cast is sound.
    renderLinks: (_doc, links) => renderLinkList(links as unknown as Parameters<typeof renderLinkList>[0]),
    themeTrustPanel: mapConsolePaletteToPanel
  });
}

/**
 * Bridge the console palette onto the <surface-trust-panel>'s --k-* theming
 * variables. The console already defines the Kontour --k-* tokens globally and
 * CSS custom properties inherit across the shadow boundary, so the panel themes
 * itself by cascade. This helper makes the contract explicit (and resilient if
 * the panel is mounted outside the token scope) by re-asserting the variables
 * the panel reads onto the element itself.
 */
function mapConsolePaletteToPanel(panel: HTMLElement): void {
  const vars = [
    "--k-text",
    "--k-text-muted",
    "--k-panel",
    "--k-panel-raised",
    "--k-line",
    "--k-positive",
    "--k-caution",
    "--k-negative",
    "--k-font-ui",
  ];
  for (const name of vars) {
    panel.style.setProperty(name, `var(${name})`);
  }
}

function renderRouteCallout(gate: ConsoleGate): HTMLElement | null {
  // Shared render-core builds the per-gate route callout.
  return renderRouteCalloutCore(document, gate);
}

function renderGateMeta(gate: ConsoleGate): HTMLElement {
  const details = document.createElement("details");
  details.className = "drawer-meta-details";
  const summary = document.createElement("summary");
  summary.textContent = "Gate metadata";
  const dl = document.createElement("dl");
  dl.className = "meta-grid";

  const addRow = (label: string, value: string | null | undefined) => {
    if (!value) return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  };

  addRow("Gate ID", gate.id);
  addRow("Step", gate.step_id);
  addRow("Status", gate.status);
  if (gate.accepted_exception_id) addRow("Exception", gate.accepted_exception_id);

  details.append(summary, dl);
  return details;
}

function renderDrawerContent(gate: ConsoleGate): void {
  if (!_drawerEl) return;
  const body = _drawerEl.querySelector<HTMLElement>(".drawer-body");
  if (!body) return;
  body.innerHTML = "";

  const statusBadge = document.createElement("span");
  statusBadge.className = `status-hero ${getStatusClass(gate.status)}`;
  statusBadge.textContent = gate.status;

  const gateTitle = document.createElement("h2");
  gateTitle.className = "drawer-gate-title";
  gateTitle.textContent = gate.id;

  const titleRow = document.createElement("div");
  titleRow.className = "drawer-title-row";
  titleRow.append(statusBadge, gateTitle);

  body.append(titleRow);

  if (gate.summary) {
    body.append(clampedText(gate.summary, "gate-summary"));
  }

  const routeCallout = renderRouteCallout(gate);
  if (routeCallout) body.append(routeCallout);

  body.append(renderGateChecklist(gate));
  body.append(renderEvidenceSection(gate));
  body.append(renderGateMeta(gate));
}

export function renderDrawer(projection: ConsoleProjection): HTMLElement {
  _currentProjection = projection;
  const overlay = document.createElement("div");
  overlay.className = "drawer-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.addEventListener("click", closeDrawer);

  const drawer = document.createElement("aside");
  drawer.className = "drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-label", "Gate details");
  drawer.setAttribute("aria-hidden", "true");

  const header = document.createElement("div");
  header.className = "drawer-header";
  const closeBtn = document.createElement("button");
  closeBtn.className = "drawer-close";
  closeBtn.setAttribute("aria-label", "Close gate details");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeDrawer);

  const headerTitle = document.createElement("span");
  headerTitle.className = "drawer-header-label";
  headerTitle.textContent = "Gate details";
  header.append(headerTitle, closeBtn);

  const body = document.createElement("div");
  body.className = "drawer-body";

  drawer.append(header, body);

  const wrapper = document.createElement("div");
  wrapper.className = "drawer-wrapper";
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.append(overlay, drawer);

  _drawerEl = wrapper;
  return wrapper;
}

export function openDrawer(gate: ConsoleGate, projection: ConsoleProjection): void {
  _currentProjection = projection;
  _openGateId = gate.id;
  if (!_drawerEl) return;
  renderDrawerContent(gate);
  _drawerEl.setAttribute("aria-hidden", "false");
  _drawerEl.classList.add("drawer-open");
  const drawer = _drawerEl.querySelector<HTMLElement>(".drawer");
  if (drawer) {
    drawer.removeAttribute("aria-hidden");
    const focusTarget = drawer.querySelector<HTMLElement>("button, [href], input, [tabindex]");
    focusTarget?.focus();
  }
  document.addEventListener("keydown", onDrawerKeydown);
}

export function closeDrawer(): void {
  _openGateId = null;
  if (!_drawerEl) return;
  _drawerEl.setAttribute("aria-hidden", "true");
  _drawerEl.classList.remove("drawer-open");
  const drawer = _drawerEl.querySelector<HTMLElement>(".drawer");
  if (drawer) drawer.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onDrawerKeydown);
}

function onDrawerKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    closeDrawer();
  }
}
