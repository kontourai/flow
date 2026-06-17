import { renderGraph as renderGraphCore } from "./render-core.js";
import type { ConsoleGate, ConsoleProjection } from "./types.js";

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

export function renderGraph(
  projection: ConsoleProjection,
  onNodeClick: (gate: ConsoleGate, projection: ConsoleProjection) => void
) {
  // Delegate the DAG (stage statuses + gate chips) to the shared render-core so
  // the loopback page and <flow-run-panel> render identical graphs.
  return renderGraphCore(document, projection, {
    onNodeActivate: (gate, proj) => onNodeClick(gate as ConsoleGate, proj as ConsoleProjection)
  });
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
