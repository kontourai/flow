import { renderLinkList } from "./links.js";
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

function badge(value: string, modClass?: string): HTMLElement {
  const b = document.createElement("span");
  b.className = `badge${modClass ? ` badge-${modClass}` : ""}`;
  b.textContent = value;
  return b;
}

function getStatusClass(status: string | null | undefined) {
  if (!status) return "status-unknown";
  return `status-${status.replace(/\s+/g, "-").toLowerCase()}`;
}

function renderGateChecklist(gate: ConsoleGate): HTMLElement {
  const section = document.createElement("section");
  section.className = "drawer-section";
  const title = document.createElement("h3");
  title.className = "drawer-section-title";
  title.textContent = "What this gate needs";
  section.append(title);

  if (!gate.expectations.length) {
    const none = document.createElement("p");
    none.className = "drawer-empty";
    none.textContent = "No expectations defined.";
    section.append(none);
    return section;
  }

  const list = document.createElement("ul");
  list.className = "checklist";

  for (const exp of gate.expectations) {
    const isMissing = gate.missing.includes(exp.id) || gate.optional_missing.includes(exp.id);
    const item = document.createElement("li");
    item.className = `checklist-item ${isMissing ? "checklist-missing" : "checklist-met"}`;

    const check = document.createElement("span");
    check.className = "checklist-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = isMissing ? "✗" : "✓";

    const label = document.createElement("span");
    label.className = "checklist-label";
    const desc = exp.description ?? exp.id;

    if (desc.length > 100) {
      label.append(...[desc.slice(0, 100)]);
      const expandSpan = document.createElement("span");
      expandSpan.className = "checklist-overflow hidden";
      expandSpan.textContent = desc.slice(100);
      const moreBtn = document.createElement("button");
      moreBtn.className = "clamp-toggle inline";
      moreBtn.textContent = "…more";
      moreBtn.addEventListener("click", () => {
        const shown = expandSpan.classList.toggle("hidden");
        moreBtn.textContent = shown ? "…more" : " less";
      });
      label.append(moreBtn, expandSpan);
    } else {
      label.textContent = desc;
    }

    if (!exp.required) {
      const optBadge = document.createElement("span");
      optBadge.className = "badge badge-neutral";
      optBadge.textContent = "optional";
      item.append(check, label, optBadge);
    } else {
      item.append(check, label);
    }

    list.append(item);
  }
  section.append(list);
  return section;
}

function renderEvidenceSection(gate: ConsoleGate): HTMLElement {
  const section = document.createElement("section");
  section.className = "drawer-section";
  const title = document.createElement("h3");
  title.className = "drawer-section-title";
  title.textContent = "Evidence";
  section.append(title);

  if (!gate.evidence.length) {
    const none = document.createElement("p");
    none.className = "drawer-empty";
    none.textContent = "No evidence attached.";
    section.append(none);
    return section;
  }

  for (const ev of gate.evidence) {
    const row = document.createElement("article");
    row.className = "evidence-row";

    const head = document.createElement("div");
    head.className = "evidence-head";

    const idSpan = document.createElement("strong");
    idSpan.className = "evidence-id";
    idSpan.textContent = ev.id;

    const badges = document.createElement("span");
    badges.className = "evidence-badges";
    if (ev.kind) badges.append(badge(ev.kind, "kind"));
    if (ev.status) badges.append(badge(ev.status, getStatusClass(ev.status)));
    if (ev.producer) badges.append(badge(ev.producer, "producer"));

    head.append(idSpan, badges);
    row.append(head);

    if (ev.external_links.length) {
      row.append(renderLinkList(ev.external_links));
    }

    // Nested Surface trust panel: when the evidence carries a pre-derived
    // TrustReport, mount Surface's own read-only element to render it. Flow does
    // NOT re-derive or re-style trust state here — it hands the element the
    // already-derived report and lets Surface render it (by reference, not
    // embedding, at the UI layer). Degrades gracefully: if the element module
    // is not registered the unknown element renders empty and setting .report
    // is harmless.
    if (ev.bundle_report) {
      const panel = document.createElement("surface-trust-panel") as HTMLElement & { report?: unknown };
      panel.className = "evidence-trust-panel";
      panel.setAttribute("heading", "Trust report");
      // Map the console palette onto Surface's --k-* theming variables so the
      // nested panel matches the drawer.
      mapConsolePaletteToPanel(panel);
      panel.report = ev.bundle_report;
      row.append(panel);
    }

    section.append(row);
  }
  return section;
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
  if (!gate.route_reason && !gate.route_back_to) return null;
  const callout = document.createElement("div");
  callout.className = "route-callout";
  if (gate.route_back_to) {
    const routeTitle = document.createElement("strong");
    routeTitle.textContent = `Route back to ${gate.route_back_to}`;
    callout.append(routeTitle);
  }
  if (gate.route_reason) {
    callout.append(clampedText(gate.route_reason, "route-reason"));
  }
  if (gate.attempt) {
    const attemptNote = document.createElement("span");
    attemptNote.className = "route-attempt";
    attemptNote.textContent = `Attempt ${gate.attempt} of ${gate.max_attempts ?? "?"}`;
    callout.append(attemptNote);
  }
  return callout;
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
