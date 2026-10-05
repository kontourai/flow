import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants, existsSync, watch as fsWatch } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  projectFlowRunFromFiles,
  type FlowConsoleProjection
} from "./console-projection.js";
import { loadRunAtResolvedLocation } from "../runtime/flow-run-store.js";
import { withRunRecoveryFenceRead } from "../runtime/flow-run-recovery-fence.js";
import { runDir } from "../runtime/flow-files.js";

export interface FlowConsoleServerOptions {
  runId: string;
  cwd?: string;
  host?: string;
  port?: number;
  open?: boolean;
}

interface ConsoleArtifactReadHooks {
  afterPathValidation?: () => Promise<void> | void;
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
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

// Run artifacts are files a run produced: untrusted content served from the
// console's own origin. Three classes, by extension:
//  - raster images keep their image type (no script can run in one);
//  - text-like files are shown as text. Markup and code (.html, .svg, .js…)
//    are text/plain so a browser never treats them as a document;
//  - anything else is a download.
// ARTIFACT_HEADERS holds the line a second way: a sandboxed response cannot
// run script even if a type is added here later.
const ARTIFACT_IMAGE_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};
const ARTIFACT_TEXT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};
const ARTIFACT_PLAIN_TEXT_EXTENSIONS = new Set([
  ".txt", ".log", ".out", ".err", ".jsonl", ".ndjson", ".sarif", ".py", ".csv", ".tsv", ".diff", ".patch", ".yaml", ".yml", ".toml", ".ini", ".xml",
  ".html", ".htm", ".xhtml", ".svg", ".css", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".sh"
]);
const ARTIFACT_HEADERS = { "content-security-policy": "default-src 'none'; sandbox" };

function artifactResponseHeaders(relativePath: string): { contentType: string; headers: Record<string, string> } {
  const extension = path.extname(relativePath).toLowerCase();
  const inline = ARTIFACT_IMAGE_TYPES[extension]
    ?? ARTIFACT_TEXT_TYPES[extension]
    ?? (ARTIFACT_PLAIN_TEXT_EXTENSIONS.has(extension) ? "text/plain; charset=utf-8" : undefined);
  if (inline) return { contentType: inline, headers: ARTIFACT_HEADERS };
  return { contentType: "application/octet-stream", headers: { ...ARTIFACT_HEADERS, "content-disposition": "attachment" } };
}

const SSE_DEBOUNCE_MS = 250;
const SSE_POLL_INTERVAL_MS = 2000;

function uiAssetRoot() {
  return path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "console-ui");
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType = "text/plain; charset=utf-8",
  extraHeaders: Record<string, string> = {}
) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}) {
  send(response, status, JSON.stringify(value, null, 2), "application/json; charset=utf-8", extraHeaders);
}

function safeRelativePath(value: string) {
  if (!value || path.isAbsolute(value) || value.includes("\0")) return null;
  const rawParts = value.split(/[\\/]/);
  if (rawParts.some((part) => !part || part === "." || part === "..")) return null;
  const normalized = path.normalize(value);
  if (normalized.startsWith("..") || normalized.split(path.sep).some((part) => part === "..")) return null;
  return normalized;
}

/** @internal Exported for deterministic descriptor-integrity verification. */
export async function readConsoleArtifact(
  runRoot: string,
  pinnedRunRoot: string,
  relativePath: string,
  hooks: ConsoleArtifactReadHooks = {}
) {
  const safePath = safeRelativePath(relativePath);
  if (!safePath) return null;
  const resolved = path.resolve(runRoot, safePath);
  const root = path.resolve(runRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  let expectedLeaf: { dev: number | bigint; ino: number | bigint } | undefined;
  let handle;
  try {
    let cursor = root;
    const parts = safePath.split(path.sep);
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) return null;
      if (index < parts.length - 1 && !entry.isDirectory()) return null;
      if (index === parts.length - 1 && !entry.isFile()) return null;
      if (index === parts.length - 1) expectedLeaf = entry;
    }
    const [rootReal, artifactReal] = await Promise.all([realpath(root), realpath(resolved)]);
    if (rootReal !== pinnedRunRoot) return null;
    if (!artifactReal.startsWith(`${rootReal}${path.sep}`)) return null;
    await hooks.afterPathValidation?.();
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !expectedLeaf ||
      String(opened.dev) !== String(expectedLeaf.dev) ||
      String(opened.ino) !== String(expectedLeaf.ino)
    ) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readProjection(runId: string, cwd: string): Promise<FlowConsoleProjection> {
  return projectFlowRunFromFiles(runId, { cwd, repairReports: true });
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
  subscriberCount: () => number;
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
      const projection = await projectFlowRunFromFiles(runId, {
        cwd,
        repairReports: true
      });
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
  // Keep polling even when fs.watch succeeds. A recovery may atomically
  // replace the fixed run directory, leaving the original watcher bound to
  // the retired inode; polling re-resolves the canonical path after reopening.
  startPolling();

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
    subscriberCount() {
      return subscribers.size;
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

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "connection": "keep-alive",
  "x-accel-buffering": "no"
};

// Live GET streams. close() ends each one so the client sees a clean
// end-of-stream and the connection can drain; server.close() alone waits on
// them forever because a stream response never finishes by itself.
interface SseStreams {
  closing: boolean;
  open: Set<ServerResponse>;
}

function handleSseRequest(
  request: IncomingMessage,
  response: ServerResponse,
  watcher: RunWatcher,
  streams: SseStreams
) {
  // A HEAD response has no body, so Node drops every write() and holds the
  // headers until end(). Without this the request never answers and keeps a
  // subscriber until the client gives up. Answer with the headers alone. The
  // hop-by-hop `connection: keep-alive` is left out: it exists to hold the
  // stream open, and on HEAD it would override a client's `Connection: close`.
  if (request.method === "HEAD") {
    const { connection: _connection, ...headHeaders } = SSE_HEADERS;
    response.writeHead(200, headHeaders);
    response.end();
    return;
  }
  // A stream that opens after close() began would subscribe to a watcher that
  // is shutting down and hold the server open. Refuse it instead.
  if (streams.closing) {
    send(response, 503, "console is shutting down", undefined, { connection: "close" });
    return;
  }
  response.writeHead(200, SSE_HEADERS);
  streams.open.add(response);
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
    streams.open.delete(response);
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
  streams: SseStreams
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    // Every response under /artifacts/ is sandboxed, error paths included.
    // Until the URL has parsed, assume the worst.
    let errorHeaders: Record<string, string> = ARTIFACT_HEADERS;
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const isArtifactRequest = url.pathname.startsWith("/artifacts/");
      errorHeaders = isArtifactRequest ? ARTIFACT_HEADERS : {};
      if (request.method !== "GET" && request.method !== "HEAD") {
        send(response, 405, "method not allowed", undefined, { ...errorHeaders, allow: "GET, HEAD" });
        return;
      }
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true, run_id: options.runId });
        return;
      }
      if (url.pathname === "/api/projection") {
        sendJson(response, 200, await readProjection(options.runId, options.cwd));
        return;
      }
      if (url.pathname === "/api/stream") {
        handleSseRequest(request, response, watcher, streams);
        return;
      }
      if (isArtifactRequest) {
        let relative: string;
        try {
          relative = decodeURIComponent(url.pathname.slice("/artifacts/".length));
        } catch {
          send(response, 400, "malformed artifact path", undefined, ARTIFACT_HEADERS);
          return;
        }
        let artifact: Buffer | null;
        try {
          artifact = await withRunRecoveryFenceRead(options.runId, options.cwd, async () => {
            const current = await loadRunAtResolvedLocation(options.runId, runRoot, options.cwd);
            const currentRunRoot = await realpath(current.dir);
            return readConsoleArtifact(current.dir, currentRunRoot, relative);
          });
        } catch (error) {
          const code = (error as Error & { code?: string }).code;
          if (
            code !== "flow.run_recovery.path_invalid" &&
            code !== "flow.run_location.resolved_dir_invalid"
          ) throw error;
          artifact = null;
        }
        if (!artifact) {
          send(response, 404, "artifact not found", undefined, ARTIFACT_HEADERS);
          return;
        }
        const { contentType, headers } = artifactResponseHeaders(relative);
        send(response, 200, artifact, contentType, headers);
        return;
      }
      await serveStatic(url.pathname, response);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      }, errorHeaders);
    }
  };
}

const sseSubscriberCounts = new WeakMap<FlowConsoleServerHandle, () => number>();

/** @internal Exported so tests can assert /api/stream releases its subscribers. */
export function consoleSseSubscriberCount(handle: FlowConsoleServerHandle): number {
  const count = sseSubscriberCounts.get(handle);
  if (!count) throw new Error("not a flow console server handle");
  return count();
}

export async function startFlowConsoleServer(options: FlowConsoleServerOptions): Promise<FlowConsoleServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("flow console only serves loopback hosts");
  const cwd = path.resolve(options.cwd ?? process.cwd());
  await projectFlowRunFromFiles(options.runId, { cwd, repairReports: true });
  const resolvedRunDir = runDir(options.runId, cwd);
  await realpath(resolvedRunDir);

  const watcher = createRunWatcher(options.runId, cwd, resolvedRunDir);
  const streams: SseStreams = { closing: false, open: new Set() };
  const server = createServer(routeRequest({ runId: options.runId, cwd }, watcher, resolvedRunDir, streams));
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
  let closing: Promise<void> | undefined;
  const close = async () => {
    streams.closing = true;
    // End every live stream with a terminating chunk, then wait for each to
    // flush so its keep-alive connection is idle before server.close() runs.
    const ended = [...streams.open].map((response) => new Promise<void>((resolve) => {
      if (response.writableFinished || response.destroyed) return resolve();
      response.once("finish", () => resolve());
      response.once("close", () => resolve());
      response.end();
    }));
    await Promise.all(ended);
    await watcher.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // server.close() (Node >= 19) drops connections idle at the time of the
      // call. Do it explicitly too: the ended streams' sockets are idle now.
      server.closeIdleConnections();
    });
  };
  const handle: FlowConsoleServerHandle = {
    // Idempotent: a second call shares the first call's shutdown.
    close: () => (closing ??= close()),
    host,
    port: address.port,
    runId: options.runId,
    url
  };
  sseSubscriberCounts.set(handle, () => watcher.subscriberCount());
  return handle;
}
