import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, watch as fsWatch } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectFlowRunFromResolvedRun, type FlowConsoleProjection } from "./console-projection.js";
import { loadRun, loadRunAtResolvedLocation, repairRunReports } from "../runtime/flow-run-store.js";

export interface FlowConsoleServerOptions {
  runId: string;
  cwd?: string;
  host?: string;
  port?: number;
  open?: boolean;
}

export interface FlowConsoleServerHandle {
  close: () => Promise<void>;
  host: string;
  port: number;
  runId: string;
  url: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

const SSE_DEBOUNCE_MS = 250;
const SSE_POLL_INTERVAL_MS = 2000;

function uiAssetRoot() {
  return path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "console-ui");
}

function send(response: ServerResponse, status: number, body: string | Buffer, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  send(response, status, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}

function safeRelativePath(value: string) {
  if (!value || path.isAbsolute(value) || value.includes("\0")) return null;
  const rawParts = value.split(/[\\/]/);
  if (rawParts.some((part) => !part || part === "." || part === "..")) return null;
  const normalized = path.normalize(value);
  if (normalized.startsWith("..") || normalized.split(path.sep).some((part) => part === "..")) return null;
  return normalized;
}

async function safeArtifactPath(runRoot: string, pinnedRunRoot: string, relativePath: string) {
  const safePath = safeRelativePath(relativePath);
  if (!safePath) return null;
  const resolved = path.resolve(runRoot, safePath);
  const root = path.resolve(runRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  try {
    let cursor = root;
    const parts = safePath.split(path.sep);
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) return null;
      if (index < parts.length - 1 && !entry.isDirectory()) return null;
      if (index === parts.length - 1 && !entry.isFile()) return null;
    }
    const [rootReal, artifactReal] = await Promise.all([realpath(root), realpath(resolved)]);
    if (rootReal !== pinnedRunRoot) return null;
    return artifactReal.startsWith(`${rootReal}${path.sep}`) ? artifactReal : null;
  } catch {
    return null;
  }
}

async function readProjection(runId: string, cwd: string, resolvedRunDir: string): Promise<FlowConsoleProjection> {
  const run = await loadRunAtResolvedLocation(runId, resolvedRunDir, cwd);
  const repaired = await repairRunReports(run);
  return projectFlowRunFromResolvedRun(repaired, { cwd });
}

async function serveStatic(urlPath: string, response: ServerResponse) {
  const assetRoot = uiAssetRoot();
  const relative = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const safePath = safeRelativePath(relative);
  if (!safePath) {
    send(response, 404, "not found");
    return;
  }
  const filePath = path.resolve(assetRoot, safePath);
  if (!filePath.startsWith(`${path.resolve(assetRoot)}${path.sep}`) && filePath !== path.resolve(assetRoot, "index.html")) {
    send(response, 404, "not found");
    return;
  }
  if (!existsSync(filePath)) {
    send(response, 404, "not found");
    return;
  }
  const contentType = MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream";
  send(response, 200, await readFile(filePath), contentType);
}

// ---------------------------------------------------------------------------
// SSE broadcaster — watches the run directory and notifies subscribers
// ---------------------------------------------------------------------------

type SseSubscriber = (data: string) => void;

export interface RunWatcher {
  subscribe: (fn: SseSubscriber) => () => void;
  close: () => Promise<void>;
}

export function createRunWatcher(runId: string, cwd: string, resolvedRunDir: string): RunWatcher {
  const watchDir = resolvedRunDir;
  const subscribers = new Set<SseSubscriber>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: ReturnType<typeof fsWatch> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastProjectionJson = "";
  let closed = false;
  const pendingNotifications = new Set<Promise<void>>();

  const notify = async () => {
    if (closed) return;
    try {
      const run = await loadRunAtResolvedLocation(runId, resolvedRunDir, cwd);
      const repaired = await repairRunReports(run);
      const projection = await projectFlowRunFromResolvedRun(repaired, { cwd });
      const json = JSON.stringify(projection);
      if (json === lastProjectionJson) return;
      lastProjectionJson = json;
      for (const fn of subscribers) {
        try { fn(json); } catch { /* subscriber disconnected */ }
      }
    } catch { /* file not ready yet */ }
  };

  const startNotification = () => {
    const pending = notify();
    pendingNotifications.add(pending);
    void pending.finally(() => pendingNotifications.delete(pending));
  };

  const schedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      startNotification();
    }, SSE_DEBOUNCE_MS);
  };

  // Try fs.watch; fall back to polling on error
  try {
    watcher = fsWatch(watchDir, { recursive: true }, () => schedule());
    watcher.once("error", () => {
      watcher = null;
      if (!closed) startPolling();
    });
  } catch {
    startPolling();
  }

  function startPolling() {
    if (pollTimer || closed) return;
    pollTimer = setInterval(startNotification, SSE_POLL_INTERVAL_MS);
    if (pollTimer.unref) pollTimer.unref();
  }

  // Unref watcher so it doesn't keep the process alive
  if (watcher && (watcher as any).unref) (watcher as any).unref();

  return {
    subscribe(fn: SseSubscriber) {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
    async close() {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      try { watcher?.close(); } catch { /* ignore */ }
      await Promise.allSettled([...pendingNotifications]);
      subscribers.clear();
    }
  };
}

function handleSseRequest(
  request: IncomingMessage,
  response: ServerResponse,
  watcher: RunWatcher
) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
  // Initial keep-alive comment
  response.write(": connected\n\n");

  const unsubscribe = watcher.subscribe((json) => {
    response.write(`event: projection\ndata: ${json}\n\n`);
  });

  const keepAlive = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, 15000);
  if (keepAlive.unref) keepAlive.unref();

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribe();
  };

  request.once("close", cleanup);
  request.once("aborted", cleanup);
  response.once("close", cleanup);
  response.once("finish", cleanup);
}

function routeRequest(
  options: Required<Pick<FlowConsoleServerOptions, "runId" | "cwd">>,
  watcher: RunWatcher,
  runRoot: string,
  pinnedRunRoot: string
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET" && request.method !== "HEAD") {
        send(response, 405, "method not allowed");
        return;
      }
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true, run_id: options.runId });
        return;
      }
      if (url.pathname === "/api/projection") {
        sendJson(response, 200, await readProjection(options.runId, options.cwd, runRoot));
        return;
      }
      if (url.pathname === "/api/stream") {
        handleSseRequest(request, response, watcher);
        return;
      }
      if (url.pathname.startsWith("/artifacts/")) {
        const relative = decodeURIComponent(url.pathname.slice("/artifacts/".length));
        const artifactPath = await safeArtifactPath(runRoot, pinnedRunRoot, relative);
        if (!artifactPath) {
          send(response, 404, "artifact not found");
          return;
        }
        const contentType = MIME_TYPES[path.extname(artifactPath)] ?? "application/octet-stream";
        send(response, 200, await readFile(artifactPath), contentType);
        return;
      }
      await serveStatic(url.pathname, response);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}

export async function startFlowConsoleServer(options: FlowConsoleServerOptions): Promise<FlowConsoleServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("flow console only serves loopback hosts");
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const loaded = await loadRun(options.runId, cwd);
  const run = await repairRunReports(loaded);
  const pinnedRunRoot = await realpath(run.dir);
  await projectFlowRunFromResolvedRun(run, { cwd });

  const watcher = createRunWatcher(options.runId, cwd, run.dir);
  const server = createServer(routeRequest({ runId: options.runId, cwd }, watcher, run.dir, pinnedRunRoot));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unable to determine console server address");
  const normalizedHost = host === "::1" ? "[::1]" : host;
  const url = `http://${normalizedHost}:${address.port}/`;
  return {
    close: async () => {
      await watcher.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    host,
    port: address.port,
    runId: options.runId,
    url
  };
}
