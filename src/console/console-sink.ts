import { assertSafeRunArtifactWritePath, writeJson } from "../runtime/flow-files.js";
import { loadRun, loadRunAtResolvedLocation } from "../runtime/flow-run-store.js";
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
  emit(projection: FlowConsoleProjection, context?: ConsoleSinkEmitContext): Promise<void>;
}

/** Local-only delivery context; hosted sinks must not include it in their payload. */
export interface ConsoleSinkEmitContext {
  resolvedRunDir?: string;
}

/**
 * Hosted-console ingest contract — v1 (provisional).
 *
 * The wire envelope `HostedConsoleSink` POSTs to `<console-base>/ingest/flow`.
 * Flow OWNS the `payload`; console owns the `kontour.console.event` envelope it
 * wraps around the payload on ingest. This type is the contract surface console
 * imports (from `@kontourai/flow/console-contract`) to VALIDATE incoming bodies
 * — keeping the dependency arrow console → flow. It is console-package-free.
 *
 * See `docs/design/hosted-console-ingest-contract.md` for the full contract.
 *
 *   POST  <console-base>/ingest/flow
 *   Auth: Authorization: Bearer <per-product token>   (env-configured; absent ⇒
 *         HostedConsoleSink disabled, FileConsoleSink only)
 *   Body: this envelope as JSON
 *   Response: 202 { recordId } on accept; 4xx { error } on validation failure.
 *
 * Generic over the projection payload so console can pin it to
 * `FlowConsoleProjection` while Flow keeps it open for future payload shapes.
 */
export interface FlowIngestRequest<TPayload = FlowConsoleProjection> {
  /** Contract version. v1 is the only value today. */
  contractVersion: "1";
  /** Always "flow" — the producing product. */
  source: "flow";
  /**
   * The FlowConsoleProjection record type / discriminator (e.g. a
   * transition/projection type). Console may route or wrap on this.
   */
  type: string;
  /**
   * `<runId>:<monotonic seq>` — retries dedup on this. Re-POSTing the same
   * idempotencyKey must be safe (console returns the same recordId).
   */
  idempotencyKey: string;
  /** ISO-8601 timestamp of when the projected state occurred. */
  occurredAt: string;
  /** Flow OWNS this. Console wraps it into a kontour.console.event envelope. */
  payload: TPayload;
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
    const reserved = new Set(["definition.json", "state.json", "report.json", "report.md"]);
    if (
      !/^[A-Za-z0-9._-]+\.json$/.test(this.fileName) ||
      reserved.has(this.fileName.toLowerCase())
    ) {
      throw new Error("FileConsoleSink fileName must be a non-authoritative run-local .json filename");
    }
  }

  async emit(projection: FlowConsoleProjection, context: ConsoleSinkEmitContext = {}): Promise<void> {
    let run: any;
    if (context.resolvedRunDir) {
      try {
        run = await loadRunAtResolvedLocation(
          projection.run.run_id,
          context.resolvedRunDir,
          this.cwd
        );
      } catch (error) {
        throw new Error(
          `flow.console_sink.resolved_run_dir_mismatch: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      run = await loadRun(projection.run.run_id, this.cwd);
    }
    if (
      projection.run.definition_id !== run.definition.id ||
      projection.run.definition_version !== run.definition.version ||
      projection.definition.id !== run.definition.id ||
      projection.definition.version !== run.definition.version
    ) {
      throw new Error("flow.console_sink.projection_identity_mismatch: projection definition does not match resolved run");
    }
    const target = await assertSafeRunArtifactWritePath(run.dir, this.fileName);
    await writeJson(target, projection);
  }
}

export interface HostedConsoleSinkOptions {
  /**
   * The console BASE url (e.g. `https://console.kontourai.io` OR a self-hosted
   * URL). The sink POSTs to `<baseUrl>/ingest/flow`. REQUIRED — there is no
   * default; the sink is OFF unless explicitly configured.
   *
   * Backwards/ergonomics: if the configured URL already ends in `/ingest/flow`
   * it is used verbatim; otherwise `/ingest/flow` is appended.
   */
  endpoint: string;
  /**
   * Per-product bearer token, sent as `authorization: Bearer <token>`. Absent ⇒
   * the hosted sink is disabled (see `createConsoleSink`): only the
   * `FileConsoleSink` runs.
   */
  authToken?: string;
  /** Extra headers merged onto the request (e.g. a tenant id). */
  headers?: Record<string, string>;
  /** Injectable fetch (defaults to global fetch) for testing. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms (default 10000). */
  timeoutMs?: number;
}

/** Resolve the configured base URL to the `/ingest/flow` route. */
function ingestUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/ingest/flow") ? trimmed : `${trimmed}/ingest/flow`;
}

/**
 * Hosted sink: build the hosted-console ingest envelope (`FlowIngestRequest`)
 * around Flow's `FlowConsoleProjection` and POST it to
 * `<baseUrl>/ingest/flow`. It imports NOTHING from any `@kontourai/console-*`
 * package — it knows only the HTTP contract (`docs/design/hosted-console-ingest-contract.md`,
 * v1 provisional). The receiving console validates the envelope against Flow's
 * EXPORTED `FlowIngestRequest` type and wraps `payload` in its own
 * `kontour.console.event` envelope — authority stays put.
 *
 * The sink is config-gated and OFF by default; `createConsoleSink` only builds
 * it when a base URL AND a bearer token are configured.
 */
export class HostedConsoleSink implements ConsoleSink {
  readonly kind = "hosted" as const;
  private readonly url: string;
  private readonly authToken?: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** Monotonic per-sink sequence, combined with runId for the idempotencyKey. */
  private sequence = 0;

  constructor(options: HostedConsoleSinkOptions) {
    if (!options.endpoint || typeof options.endpoint !== "string") {
      throw new Error("HostedConsoleSink requires a configured `endpoint` (it is OFF by default)");
    }
    this.url = ingestUrl(options.endpoint);
    this.authToken = options.authToken;
    this.headers = options.headers ?? {};
    const candidate = options.fetchImpl ?? globalThis.fetch;
    if (typeof candidate !== "function") {
      throw new Error("HostedConsoleSink needs a fetch implementation (global fetch unavailable)");
    }
    this.fetchImpl = candidate;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  /**
   * Build the v1 ingest envelope for a projection. Flow OWNS the payload; this
   * is only the transport wrapper. `idempotencyKey` is `<runId>:<seq>` so a
   * retried POST dedups console-side.
   */
  private buildRequest(projection: FlowConsoleProjection): FlowIngestRequest {
    const seq = this.sequence++;
    return {
      contractVersion: "1",
      source: "flow",
      type: `flow.console.projection.${projection.schema_version}`,
      idempotencyKey: `${projection.run.run_id}:${seq}`,
      occurredAt: projection.run.updated_at ?? new Date().toISOString(),
      payload: projection
    };
  }

  async emit(projection: FlowConsoleProjection, _context?: ConsoleSinkEmitContext): Promise<void> {
    const request = this.buildRequest(projection);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
          ...this.headers
        },
        body: JSON.stringify(request),
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
 * hosted sink is only constructed when `mode: "hosted"` is explicitly set AND
 * BOTH a base URL (`hosted.endpoint`) and a bearer token (`hosted.authToken`)
 * are configured. This is the single config gate — hosted delivery is never the
 * default, and an absent token/URL disables it (FileConsoleSink only), per the
 * v1 ingest contract.
 */
export function createConsoleSink(config: ConsoleSinkConfig = {}): ConsoleSink {
  if (config.mode === "hosted") {
    if (!config.hosted?.endpoint) {
      throw new Error('console sink mode "hosted" requires `hosted.endpoint`');
    }
    // Per the v1 contract: an absent bearer token disables the hosted sink —
    // fall back to FileConsoleSink rather than POSTing unauthenticated.
    if (!config.hosted.authToken) {
      return new FileConsoleSink(config.file ?? {});
    }
    return new HostedConsoleSink(config.hosted);
  }
  return new FileConsoleSink(config.file ?? {});
}
