import { writeJson, runDir } from "../runtime/flow-files.js";
import path from "node:path";

import type { FlowConsoleProjection } from "./console-projection.js";

/**
 * ConsoleSink — the seam by which Flow delivers its OWN typed projection
 * (`FlowConsoleProjection`) to a console plane.
 *
 * RESOLVED DECISION 2 (replaces flow-followups §3's generic `.kontour/events`):
 * Flow does NOT emit generic `@kontourai/console-core` records and depends on NO
 * console package. Flow owns the projection contract; a sink only knows where to
 * PUT that payload. Two shapes:
 *   - `FileConsoleSink`  — materialize the projection locally (today's behaviour;
 *                          the loopback console-server serves it). DEFAULT.
 *   - `HostedConsoleSink` — POST the SAME payload to a configurable console
 *                          ingest endpoint over HTTP. Config-gated, OFF by
 *                          default. Imports nothing from any console package —
 *                          it only knows an HTTP contract whose body Flow owns.
 *
 * Console wraps the payload in its own `kontour.console.event` envelope on
 * ingest (console's flow-bridge already does this for the local/pull case).
 * Flow never produces that envelope — authority stays put (Flow owns process,
 * console aggregates read-only).
 */
export interface ConsoleSink {
  /** Stable discriminator for diagnostics/config. */
  readonly kind: "file" | "hosted";
  /**
   * Deliver one projection snapshot. Implementations must be side-effect-only
   * (no return value the caller depends on); a failure should reject so callers
   * can log it without it being mistaken for authoritative state.
   */
  emit(projection: FlowConsoleProjection): Promise<void>;
}

export interface FileConsoleSinkOptions {
  cwd?: string;
  /** Override the run-local projection filename (default `console-projection.json`). */
  fileName?: string;
}

/**
 * Default sink: write the projection to a run-local JSON file under the Flow run
 * directory. This is the local pull/serve model — the file lives next to the
 * other Flow-owned run artifacts and the loopback console-server projects it.
 */
export class FileConsoleSink implements ConsoleSink {
  readonly kind = "file" as const;
  private readonly cwd: string;
  private readonly fileName: string;

  constructor(options: FileConsoleSinkOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.fileName = options.fileName ?? "console-projection.json";
  }

  async emit(projection: FlowConsoleProjection): Promise<void> {
    const target = path.join(runDir(projection.run.run_id, this.cwd), this.fileName);
    await writeJson(target, projection);
  }
}

export interface HostedConsoleSinkOptions {
  /**
   * The console ingest endpoint. console.kontourai.io OR a self-hosted URL.
   * REQUIRED — there is no default; the sink is OFF unless explicitly configured.
   */
  endpoint: string;
  /** Optional bearer token / API key sent as `authorization: Bearer <token>`. */
  authToken?: string;
  /** Extra headers merged onto the request (e.g. a tenant id). */
  headers?: Record<string, string>;
  /** Injectable fetch (defaults to global fetch) for testing. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms (default 10000). */
  timeoutMs?: number;
}

/**
 * Hosted sink: POST the projection payload (the exact `FlowConsoleProjection`
 * Flow owns and exports) to a configurable console ingest endpoint. It imports
 * NOTHING from any `@kontourai/console-*` package — it knows only an HTTP
 * contract:  `POST <endpoint>` with `content-type: application/json` and the
 * projection as the body. The receiving console wraps it in its own
 * `kontour.console.event` envelope.
 *
 * CAVEAT (flagged, not invented): the hosted ingest endpoint's URL/auth/envelope
 * is a CONSOLE-side contract that does not exist yet. This sink is functional
 * against any configurable URL; the concrete API shape is tracked as a follow-up
 * in `docs/handoff/console.md` (## Needs decision — hosted-ingest API contract).
 * Do not treat the request shape below as a ratified console API.
 */
export class HostedConsoleSink implements ConsoleSink {
  readonly kind = "hosted" as const;
  private readonly endpoint: string;
  private readonly authToken?: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HostedConsoleSinkOptions) {
    if (!options.endpoint || typeof options.endpoint !== "string") {
      throw new Error("HostedConsoleSink requires a configured `endpoint` (it is OFF by default)");
    }
    this.endpoint = options.endpoint;
    this.authToken = options.authToken;
    this.headers = options.headers ?? {};
    const candidate = options.fetchImpl ?? globalThis.fetch;
    if (typeof candidate !== "function") {
      throw new Error("HostedConsoleSink needs a fetch implementation (global fetch unavailable)");
    }
    this.fetchImpl = candidate;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  async emit(projection: FlowConsoleProjection): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
          ...this.headers
        },
        body: JSON.stringify(projection),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`hosted console ingest rejected projection: ${response.status} ${response.statusText}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface ConsoleSinkConfig {
  /** "file" (default) or "hosted". */
  mode?: "file" | "hosted";
  file?: FileConsoleSinkOptions;
  hosted?: HostedConsoleSinkOptions;
}

/**
 * Build a ConsoleSink from config. Defaults to the local `FileConsoleSink`; the
 * hosted sink is only constructed when `mode: "hosted"` is explicitly set AND an
 * endpoint is configured. This is the single config gate — hosted delivery is
 * never the default.
 */
export function createConsoleSink(config: ConsoleSinkConfig = {}): ConsoleSink {
  if (config.mode === "hosted") {
    if (!config.hosted?.endpoint) {
      throw new Error('console sink mode "hosted" requires `hosted.endpoint`');
    }
    return new HostedConsoleSink(config.hosted);
  }
  return new FileConsoleSink(config.file ?? {});
}
