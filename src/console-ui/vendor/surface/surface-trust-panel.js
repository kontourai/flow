// <surface-trust-panel> — a dependency-free, read-only Trust Panel custom element.
//
// Renders a derived Kontour Surface TrustReport (the output of `surface report`
// or `buildTrustReport`) so a viewer can inspect claims, evidence, freshness,
// and transparency gaps before relying on them. The element never mutates or
// re-derives trust state; it only displays what the kernel derived.
//
// The compiled dist/src/trust-panel/surface-trust-panel.js is a self-contained
// ES module with no imports — load it with <script type="module">. It reads
// untrusted pasted JSON, so the local shapes below stay loose and every
// rendered value is escaped.
//
// Usage:
//   <script type="module" src="surface-trust-panel.js"></script>
//   <surface-trust-panel></surface-trust-panel>
//   document.querySelector("surface-trust-panel").report = reportJson;
// or
//   <surface-trust-panel src="./report.json"></surface-trust-panel>
(() => {
    if (typeof customElements === "undefined" || customElements.get("surface-trust-panel"))
        return;
    const STATUS_LABELS = {
        unknown: "No evidence",
        proposed: "Pending review",
        assumed: "Assumed",
        verified: "Verified",
        stale: "Needs refresh",
        disputed: "Disputed",
        superseded: "Superseded",
        rejected: "Rejected",
    };
    const STATUS_KIND = {
        verified: "positive",
        stale: "caution",
        disputed: "negative",
        rejected: "negative",
        superseded: "neutral",
        unknown: "neutral",
        proposed: "neutral",
        assumed: "caution",
    };
    const PANEL_CSS = `
    :host {
      display: block;
      font-family: var(--k-font-ui, system-ui, sans-serif);
      color: var(--k-text, #17201b);
      line-height: 1.5;
    }
    .panel {
      border: 1px solid var(--k-line, rgba(36, 68, 52, 0.16));
      border-radius: 16px;
      background: var(--k-panel, #fffcf1);
      padding: 1rem;
    }
    .panel-header { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; align-items: baseline; }
    .panel-title { margin: 0; font-size: 1.05rem; font-weight: 700; }
    .panel-meta { margin: 0; color: var(--k-text-muted, #657267); font-size: 0.82rem; overflow-wrap: anywhere; }
    .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.8rem 0 0.4rem; }
    .chip {
      border: 1px solid var(--k-line, rgba(36, 68, 52, 0.16));
      border-radius: 999px;
      padding: 0.15rem 0.6rem;
      font-size: 0.78rem;
      font-weight: 600;
      background: var(--k-panel-raised, #fbf6e7);
    }
    .chip[data-kind="positive"] { color: var(--k-positive, #0f8f66); }
    .chip[data-kind="caution"] { color: var(--k-caution, #a86612); }
    .chip[data-kind="negative"] { color: var(--k-negative, #c24141); }
    .claim {
      border: 1px solid var(--k-line, rgba(36, 68, 52, 0.16));
      border-radius: 12px;
      margin-top: 0.6rem;
      background: var(--k-panel-raised, #fbf6e7);
    }
    .claim summary {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem 0.6rem;
      align-items: center;
      min-height: 44px;
      padding: 0.45rem 0.75rem;
      cursor: pointer;
      list-style: none;
    }
    .claim summary::-webkit-details-marker { display: none; }
    .claim-field { font-weight: 600; overflow-wrap: anywhere; }
    .claim-subject { color: var(--k-text-muted, #657267); font-size: 0.8rem; overflow-wrap: anywhere; }
    .claim-body { padding: 0 0.75rem 0.75rem; border-top: 1px solid var(--k-line, rgba(36, 68, 52, 0.16)); }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.75rem; margin: 0.6rem 0; font-size: 0.85rem; }
    dt { color: var(--k-text-muted, #657267); }
    dd { margin: 0; overflow-wrap: anywhere; }
    h3 { margin: 0.7rem 0 0.25rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--k-text-muted, #657267); }
    ul { margin: 0.2rem 0; padding-left: 1.1rem; font-size: 0.85rem; }
    li { margin: 0.25rem 0; overflow-wrap: anywhere; }
    .gap { color: var(--k-negative, #c24141); }
    .gap[data-severity="low"], .gap[data-severity="medium"] { color: var(--k-caution, #a86612); }
    .empty, .error { padding: 0.5rem 0; color: var(--k-text-muted, #657267); font-size: 0.9rem; }
    .error { color: var(--k-negative, #c24141); }
    .footnote { margin: 0.8rem 0 0; color: var(--k-text-muted, #657267); font-size: 0.75rem; }
  `;
    class SurfaceTrustPanel extends HTMLElement {
        static get observedAttributes() {
            return ["src", "heading"];
        }
        #report = null;
        #shadow;
        constructor() {
            super();
            this.#shadow = this.attachShadow({ mode: "open" });
        }
        connectedCallback() {
            // Re-apply a `report` set before the element was upgraded, so the
            // property assignment reaches the class accessor instead of being
            // shadowed by an own property.
            if (Object.prototype.hasOwnProperty.call(this, "report")) {
                const pending = this.report;
                delete this.report;
                this.report = pending;
                return;
            }
            const src = this.getAttribute("src");
            if (!this.#report && src)
                void this.#load(src);
            else
                this.#render();
        }
        attributeChangedCallback(name, oldValue, newValue) {
            if (name === "src" && newValue && newValue !== oldValue)
                void this.#load(newValue);
            if (name === "heading" && newValue !== oldValue)
                this.#render();
        }
        get report() {
            return this.#report;
        }
        set report(value) {
            this.#report = value ?? null;
            this.#render();
        }
        async #load(src) {
            try {
                const response = await fetch(src);
                if (!response.ok)
                    throw new Error(`Failed to load report: HTTP ${response.status}`);
                this.report = await response.json();
            }
            catch (error) {
                this.#renderError(error instanceof Error ? error.message : String(error));
            }
        }
        #render() {
            const report = this.#report;
            if (!report) {
                this.#renderShell('<p class="empty">No trust report loaded yet.</p>');
                return;
            }
            if (!Array.isArray(report.claims)) {
                this.#renderError("This JSON does not look like a trust report: no claims array.");
                return;
            }
            const claims = report.claims;
            if (claims.length > 0 && claims.every((claim) => !claim.status)) {
                this.#renderError("This looks like a TrustBundle rather than a derived report. Run `surface report --input <file>` first, then load the report output.");
                return;
            }
            const counts = new Map();
            for (const claim of claims) {
                const status = typeof claim.status === "string" ? claim.status : "unknown";
                counts.set(status, (counts.get(status) ?? 0) + 1);
            }
            const chips = [...counts.entries()]
                .map(([status, count]) => `<span class="chip" data-kind="${STATUS_KIND[status] ?? "neutral"}">${escapeHtml(STATUS_LABELS[status] ?? status)}: ${count}</span>`)
                .join("");
            const claimRows = claims.map((claim) => this.#renderClaim(claim, report)).join("");
            this.#renderShell(`
        <div class="panel-header">
          <p class="panel-title">${escapeHtml(this.getAttribute("heading") ?? "Surface Trust Panel")}</p>
          <p class="panel-meta">${escapeHtml(asText(report.source))}${report.generatedAt ? ` · ${escapeHtml(asText(report.generatedAt))}` : ""}</p>
        </div>
        <div class="chips">${chips}</div>
        ${claimRows || '<p class="empty">The report contains no claims.</p>'}
        <p class="footnote">Derived by Kontour Surface. Status is derived by construction — inspect the evidence and gaps before relying on a claim.</p>
      `);
        }
        #renderClaim(claim, report) {
            const status = typeof claim.status === "string" ? claim.status : "unknown";
            const evidence = asArray(report.evidence).filter((item) => item.claimId === claim.id);
            const gaps = asArray(report.transparencyGaps).filter((item) => item.claimId === claim.id);
            const evidenceList = evidence
                .map((item) => `<li><strong>${escapeHtml(asText(item.evidenceType, "evidence"))}</strong> via ${escapeHtml(asText(item.method, "unknown method"))} — ${escapeHtml(asText(item.excerptOrSummary ?? item.sourceRef))}</li>`)
                .join("");
            const gapList = gaps
                .map((item) => `<li class="gap" data-severity="${escapeHtml(asText(item.severity))}">${escapeHtml(asText(item.type, "gap"))} — ${escapeHtml(asText(item.message))}</li>`)
                .join("");
            return `<details class="claim">
        <summary>
          <span class="chip" data-kind="${STATUS_KIND[status] ?? "neutral"}">${escapeHtml(STATUS_LABELS[status] ?? status)}</span>
          <span class="claim-field">${escapeHtml(asText(claim.fieldOrBehavior ?? claim.id))}</span>
          <span class="claim-subject">${escapeHtml(asText(claim.subjectType))}: ${escapeHtml(asText(claim.subjectId))}</span>
        </summary>
        <div class="claim-body">
          <dl>
            <dt>Value</dt><dd>${escapeHtml(formatValue(claim.value))}</dd>
            <dt>Claim</dt><dd>${escapeHtml(asText(claim.id))}</dd>
            <dt>Facet</dt><dd>${escapeHtml(asText(claim.facet ?? claim.surface))}</dd>
            <dt>Impact</dt><dd>${escapeHtml(asText(claim.impactLevel, "unspecified"))}</dd>
            ${claim.verificationPolicyId ? `<dt>Policy</dt><dd>${escapeHtml(asText(claim.verificationPolicyId))}</dd>` : ""}
          </dl>
          <h3>Evidence</h3>
          ${evidenceList ? `<ul>${evidenceList}</ul>` : '<p class="empty">No evidence recorded for this claim.</p>'}
          ${gapList ? `<h3>Transparency gaps</h3><ul>${gapList}</ul>` : ""}
        </div>
      </details>`;
        }
        #renderShell(body) {
            this.#shadow.innerHTML = `<style>${PANEL_CSS}</style><div class="panel">${body}</div>`;
        }
        #renderError(message) {
            this.#renderShell(`<p class="error">${escapeHtml(message)}</p>`);
        }
    }
    function asArray(value) {
        return Array.isArray(value) ? value : [];
    }
    function asText(value, fallback = "") {
        if (value === undefined || value === null)
            return fallback;
        return String(value);
    }
    function formatValue(value) {
        if (value === undefined || value === null)
            return "—";
        return typeof value === "string" ? value : JSON.stringify(value);
    }
    function escapeHtml(text) {
        return text
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;");
    }
    customElements.define("surface-trust-panel", SurfaceTrustPanel);
})();
export {};
