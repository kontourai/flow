import type { ConsoleLink } from "./types.js";

export interface RenderableLink {
  id: string;
  kind: string;
  label: string;
  href?: string;
  detail: string;
  disabled: boolean;
}

const COMPANION_BASE: Record<string, string> = {
  surface: "http://127.0.0.1:51231",
  veritas: "http://127.0.0.1:51232"
};

function safeArtifactHref(pathValue: string) {
  if (pathValue.startsWith("/") || pathValue.includes("..") || pathValue.includes("\0")) return undefined;
  return `/artifacts/${pathValue.split("/").map(encodeURIComponent).join("/")}`;
}

function companionHref(link: ConsoleLink) {
  if (!link.href) return undefined;
  const scheme = `${link.kind}://`;
  if (!link.href.startsWith(scheme)) return link.href.startsWith("http://") || link.href.startsWith("https://") ? link.href : undefined;
  const tail = link.href.slice(scheme.length).replace(/^\/+/, "");
  return `${COMPANION_BASE[link.kind]}/${tail}`;
}

export function renderableLink(link: ConsoleLink): RenderableLink {
  const artifactHref = link.path ? safeArtifactHref(link.path) : undefined;
  const mappedHref = link.kind === "surface" || link.kind === "veritas" ? companionHref(link) : undefined;
  const directHref = link.href?.startsWith("http://") || link.href?.startsWith("https://") ? link.href : undefined;
  const href = mappedHref ?? directHref ?? artifactHref;
  const fallback = artifactHref ? `fallback artifact: ${link.path}` : link.path ? `unsafe artifact path hidden: ${link.path}` : link.href ?? link.id;
  return {
    id: link.id,
    kind: link.kind,
    label: link.label ?? link.id,
    href,
    detail: href ? fallback : `reference only: ${fallback}`,
    disabled: !href
  };
}

export function renderLinkList(links: ConsoleLink[]) {
  const list = document.createElement("ul");
  list.className = "link-list";
  for (const link of links.map(renderableLink)) {
    const item = document.createElement("li");
    item.dataset.linkKind = link.kind;
    item.dataset.linkId = link.id;
    const badge = document.createElement("span");
    badge.className = "kind";
    badge.textContent = link.kind;
    const body = link.href ? document.createElement("a") : document.createElement("span");
    body.textContent = link.label;
    body.className = link.disabled ? "disabled-link" : "";
    if (body instanceof HTMLAnchorElement) body.href = link.href;
    const detail = document.createElement("small");
    detail.textContent = link.detail;
    item.append(badge, body, detail);
    list.append(item);
  }
  return list;
}
