import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectFlowRunFromFiles, type FlowConsoleProjection } from "./console-projection.js";
import { runDir } from "./index.js";

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

function uiAssetRoot() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "console-ui");
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

function safeArtifactPath(runRoot: string, relativePath: string) {
  const safePath = safeRelativePath(relativePath);
  if (!safePath) return null;
  const resolved = path.resolve(runRoot, safePath);
  const root = path.resolve(runRoot);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

async function readProjection(runId: string, cwd: string): Promise<FlowConsoleProjection> {
  return projectFlowRunFromFiles(runId, { cwd });
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

function routeRequest(options: Required<Pick<FlowConsoleServerOptions, "runId" | "cwd">>) {
  const runRoot = runDir(options.runId, options.cwd);
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
        sendJson(response, 200, await readProjection(options.runId, options.cwd));
        return;
      }
      if (url.pathname.startsWith("/artifacts/")) {
        const relative = decodeURIComponent(url.pathname.slice("/artifacts/".length));
        const artifactPath = safeArtifactPath(runRoot, relative);
        if (!artifactPath || !existsSync(artifactPath)) {
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
  await projectFlowRunFromFiles(options.runId, { cwd });

  const server = createServer(routeRequest({ runId: options.runId, cwd }));
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    host,
    port: address.port,
    runId: options.runId,
    url
  };
}
