import { renderLinkList } from "./links.js";
import type { ConsoleGate } from "./types.js";

function line(label: string, value: string | null | undefined) {
  const row = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = label;
  row.append(strong, document.createTextNode(value ? ` ${value}` : " none"));
  return row;
}

export function renderGatePanel(gates: ConsoleGate[], currentStep: string | null) {
  const panel = document.createElement("aside");
  panel.className = "gate-panel";
  panel.dataset.testid = "flow-console-gate-panel";
  const selected = gates.find((gate) => gate.step_id === currentStep) ?? gates.find((gate) => gate.is_open) ?? gates[0];
  if (!selected) {
    panel.textContent = "No gates in this run.";
    return panel;
  }

  const title = document.createElement("h2");
  title.textContent = selected.id;
  const status = document.createElement("span");
  status.className = `status-pill status-${selected.status}`;
  status.textContent = selected.status;
  const summary = document.createElement("p");
  summary.className = "gate-summary";
  summary.textContent = selected.summary;
  panel.append(title, status, summary);

  const route = [selected.route_reason, selected.route_back_to ? `route back to ${selected.route_back_to}` : null]
    .filter(Boolean)
    .join(" | ");
  panel.append(line("Step", selected.step_id), line("Route", route), line("Attempt", selected.attempt ? `${selected.attempt}/${selected.max_attempts ?? "?"}` : null));

  const expectations = document.createElement("section");
  expectations.className = "detail-list";
  const expectationsTitle = document.createElement("h3");
  expectationsTitle.textContent = "Expectations";
  expectations.append(expectationsTitle);
  for (const expectation of selected.expectations) {
    const item = document.createElement("p");
    item.textContent = `${expectation.required ? "required" : "optional"}: ${expectation.description ?? expectation.id}`;
    expectations.append(item);
  }
  panel.append(expectations);

  const evidence = document.createElement("section");
  evidence.className = "detail-list";
  const evidenceTitle = document.createElement("h3");
  evidenceTitle.textContent = "Evidence";
  evidence.append(evidenceTitle);
  for (const entry of selected.evidence) {
    const item = document.createElement("article");
    item.className = "evidence-row";
    const id = document.createElement("strong");
    id.textContent = entry.id;
    const meta = document.createElement("span");
    meta.textContent = `${entry.kind ?? "evidence"} | ${entry.status ?? "unknown"} | ${entry.producer ?? "unknown producer"}`;
    item.append(id, meta);
    if (entry.external_links.length) item.append(renderLinkList(entry.external_links));
    evidence.append(item);
  }
  panel.append(evidence);

  const missing = document.createElement("section");
  missing.className = "detail-list";
  const missingTitle = document.createElement("h3");
  missingTitle.textContent = "Missing";
  missing.append(missingTitle);
  const values = [...selected.missing, ...selected.optional_missing.map((value) => `${value} (optional)`)];
  missing.append(document.createTextNode(values.length ? values.join(", ") : "none"));
  panel.append(missing);
  return panel;
}
