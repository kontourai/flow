#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  acceptException,
  applyFlowConfigMerge,
  attachEvidence,
  amendRunDefinition,
  authorizeRetry,
  cancelRun,
  ensureFlowLayout,
  evaluateRun,
  findGate,
  loadRun,
  previewFlowConfigMergeFile,
  projectVersionReleaseReport,
  pauseRun,
  renderConfigMergeMarkdown,
  renderConfigMergeSummary,
  renderMarkdownReport,
  renderResume,
  renderSummary,
  renderVersionReleaseReportMarkdown,
  resumeRun,
  reportJson,
  scaffoldDemoRun,
  startRun,
  validateRunTransition,
  readySteps,
  stageStatuses,
  validateDefinitionWithDiagnostics
} from "./index.js";
import { listRunsWithDiagnostics, repairRunReports } from "./runtime/flow-run-store.js";
import { startFlowConsoleServer } from "./console/console-server.js";
import { validateKitContainerFile } from "./kit/flow-kit-container.js";
import { kitInstall, kitInspect } from "./kit/kit-operations.js";
import { COMMAND_CAPTURE_DEFAULT_TIMEOUT_MS, captureCommand } from "./runtime/command-evidence.js";

type CliFlags = Record<string, any>;

function usage() {
  return `Usage:
  flow init [--demo] [--cwd <path>]
  flow validate-definition <path> [--json] [--cwd <path>]
  flow kit validate <kit-dir> [--json] [--cwd <path>]
  flow kit install <source> [--dest <path>] [--ref <ref>]
  flow kit inspect <kit-dir> [--json]
  flow validate-transition <request-json> [--cwd <path>]
  flow start <definition> [--run-id <id>] [--params key=value ...] [--cwd <path>]
  flow status <run-id> [--format summary|json|markdown] [--cwd <path>]
  flow pause <run-id> --request <request-json> [--cwd <path>]
  flow resume-run <run-id> --request <request-json> [--cwd <path>]
  flow cancel <run-id> --request <request-json> [--cwd <path>]
  flow authorize-retry <run-id> --request <request-json> [--cwd <path>]
  flow amend-definition <run-id> --definition <successor-json> --request <request-json> [--cwd <path>]
  flow attach-evidence <run-id> --gate <gate> --file <file> [--kind <kind>] [--bundle] [--supersede <evidence-id> ...] [--trust-artifact (deprecated, alias for --kind trust.bundle)] [--producer <id>] [--authority-trace <trace>] [--route-reason <reason>] [--classifier-kind <kind>] [--classifier-source <source>] [--classifier-confidence <0..1>] [--analytics-loop-key <key>] [--expectation-id <id> ...] [--route-metadata <json-file>] [--cwd <path>]
  flow capture <run-id> --gate <gate> --kind command [--timeout <ms>] [--cwd <path>] -- <cmd...>
  flow evaluate <run-id> [--gate <gate>] [--exit-code] [--cwd <path>]
  flow accept-exception <run-id> --gate <gate> --reason <reason> --authority <authority> [--cwd <path>]
  flow config preview <proposal> [--format summary|markdown|json] [--cwd <path>]
  flow config apply <proposal> [--accept-conflict <path> ...] [--exception-reason <reason>] [--authority <authority>] [--format summary|markdown|json] [--cwd <path>]
  flow report <run-id> [--format summary|markdown|json] [--cwd <path>]
  flow version-release-report <fixture-json> [--format json|markdown] [--cwd <path>]
  flow console --run <run-id> [--cwd <path>] [--host 127.0.0.1|localhost|::1] [--port <port>]
  flow resume <run-id> [--cwd <path>]
  flow list [--cwd <path>]
  flow ready-steps <run-id> [--format json] [--cwd <path>]
`;
}

function parseArgs(argv: string[]) {
  const args: string[] = [];
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "params") {
      flags.params ??= [];
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        flags.params.push(argv[++i]);
      }
      continue;
    }
    if (key === "expectation-id" || key === "accept-conflict" || key === "supersede") {
      flags[key] ??= [];
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`--${key} requires a value`);
      flags[key].push(next);
      i += 1;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { args, flags };
}

function parseCaptureArgs(argv: string[]) {
  const separator = argv.indexOf("--");
  if (separator === -1) throw new Error("flow capture requires -- before the command");
  const parsed = parseArgs(argv.slice(0, separator));
  return { ...parsed, captureCommand: argv.slice(separator + 1) };
}

function parseCaptureTimeout(value: unknown) {
  if (value === undefined) return COMMAND_CAPTURE_DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("--timeout must be a positive integer in milliseconds");
  return timeout;
}

function validateCaptureScalarFlags(flags: CliFlags) {
  for (const key of ["cwd", "gate", "kind", "timeout"]) {
    if (flags[key] === true) throw new Error(`--${key} requires a value`);
  }
}

function parseParams(values: string[] = []) {
  const params: CliFlags = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index === -1) throw new Error(`invalid --params value: ${value}`);
    params[value.slice(0, index)] = value.slice(index + 1);
  }
  return params;
}

function requireArg(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function mergeObject(base, next) {
  if (!next) return base;
  return { ...(base ?? {}), ...next };
}

function resolveCliCwd(flags: CliFlags) {
  return flags.cwd ? path.resolve(process.cwd(), flags.cwd) : process.cwd();
}

async function parseRouteMetadata(flags: CliFlags, cwd = process.cwd()) {
  const metadataFile = flags["route-metadata"] ?? flags.metadata;
  const fileMetadata = metadataFile
    ? JSON.parse(await readFile(path.resolve(cwd, metadataFile), "utf8"))
    : {};
  const classifier = compactObject({
    kind: flags["classifier-kind"],
    source: flags["classifier-source"],
    confidence: flags["classifier-confidence"] === undefined ? undefined : Number(flags["classifier-confidence"])
  });
  if (classifier.confidence !== undefined && Number.isNaN(classifier.confidence)) {
    throw new Error("--classifier-confidence must be a number");
  }
  const analytics = compactObject({
    loop_key: flags["analytics-loop-key"]
  });
  return {
    ...fileMetadata,
    route_reason: flags["route-reason"] ?? fileMetadata.route_reason,
    expectation_ids: flags["expectation-id"] ?? fileMetadata.expectation_ids,
    classifier: Object.keys(classifier).length ? mergeObject(fileMetadata.classifier, classifier) : fileMetadata.classifier,
    diagnostics: fileMetadata.diagnostics,
    analytics: Object.keys(analytics).length ? mergeObject(fileMetadata.analytics, analytics) : fileMetadata.analytics
  };
}

async function printStatus(runId, format, cwd = process.cwd()) {
  const run = await loadRun(runId, cwd);
  const diagnostics = run.diagnostics;
  if (format === "json") {
    const base = reportJson(run.definition, run.state, run.manifest);
    const ready = readySteps(run.definition, run.state, run.manifest);
    const statuses = stageStatuses(run.definition, run.state, run.manifest);
    console.log(JSON.stringify({ ...base, readySteps: ready, stageStatuses: statuses, diagnostics }, null, 2));
  } else if (format === "markdown") {
    process.stdout.write(renderMarkdownReport(run.definition, run.state, run.manifest));
  } else {
    const ready = readySteps(run.definition, run.state, run.manifest);
    process.stdout.write(renderSummary(run.definition, run.state, runReportPath(run.dir, cwd)));
    if (ready.length) {
      process.stdout.write(`ready steps: ${ready.join(", ")}\n`);
    }
  }
  printRunLocationDiagnostics(diagnostics);
}

function runReportPath(dir: string, cwd: string) {
  const file = path.join(dir, "report.md");
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." ? relative : file;
}

function printRunLocationDiagnostics(diagnostics: Array<{ code: string; severity: string; message: string }>) {
  for (const diagnostic of diagnostics) {
    console.error(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
  }
}

function printConfigMergeReport(report, format) {
  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else if (format === "markdown") {
    process.stdout.write(renderConfigMergeMarkdown(report));
  } else {
    process.stdout.write(renderConfigMergeSummary(report));
  }
}

async function readDefinitionForValidation(definitionPath, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, definitionPath);
  try {
    return JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    const diagnostic = {
      code: error instanceof SyntaxError ? "definition.file.json.invalid" : "definition.file.read_failed",
      severity: "error",
      path: "$",
      message: `unable to read Flow Definition ${definitionPath}: ${error.message}`
    };
    return { __flowReadError: diagnostic };
  }
}

async function readLifecycleRequest(flags: CliFlags, cwd: string, command: string) {
  const requestPath = requireArg(flags.request, `flow ${command} requires --request <request-json>`);
  const resolved = path.resolve(cwd, requestPath);
  try {
    return JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`flow.lifecycle.request.invalid: unable to read lifecycle request ${requestPath}: ${detail}`);
  }
}

function printLifecycleResult(runId: string, result: Awaited<ReturnType<typeof pauseRun>>) {
  console.log(`${result.event.action}${result.idempotent ? " (idempotent)" : ""}: ${runId}`);
  console.log(`status: ${result.state.status}`);
  console.log(`request: ${result.event.authority.request_ref}`);
}

async function readRetryAuthorizationRequest(flags: CliFlags, cwd: string) {
  const requestPath = requireArg(flags.request, "flow authorize-retry requires --request <request-json>");
  try {
    return JSON.parse(await readFile(path.resolve(cwd, requestPath), "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`flow.retry_authorization.request.invalid: unable to read retry authorization request ${requestPath}: ${detail}`);
  }
}

async function readDefinitionAmendmentRequest(flags: CliFlags, cwd: string) {
  const requestPath = requireArg(flags.request, "flow amend-definition requires --request <request-json>");
  try {
    return JSON.parse(await readFile(path.resolve(cwd, requestPath), "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`flow.definition_amendment.request.invalid: unable to read amendment request ${requestPath}: ${detail}`);
  }
}

async function readSuccessorDefinition(flags: CliFlags, cwd: string) {
  const definitionPath = requireArg(flags.definition, "flow amend-definition requires --definition <successor-json>");
  try {
    return JSON.parse(await readFile(path.resolve(cwd, definitionPath), "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`flow.definition_amendment.request.invalid: unable to read successor definition ${definitionPath}: ${detail}`);
  }
}

function validationPayload(definitionPath, result) {
  return {
    valid: result.valid,
    path: definitionPath,
    error_count: result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    diagnostics: result.diagnostics
  };
}

function printDefinitionValidation(definitionPath, payload, json) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.valid) {
    console.log(`valid Flow Definition: ${definitionPath}`);
    return;
  }
  console.log(`invalid Flow Definition: ${definitionPath}`);
  for (const diagnostic of payload.diagnostics) {
    console.log(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }

  const { args, flags, captureCommand: captureArgv = [] } = command === "capture"
    ? parseCaptureArgs(rest)
    : { ...parseArgs(rest), captureCommand: [] };
  if (command === "capture") validateCaptureScalarFlags(flags);
  const cwd = resolveCliCwd(flags);

  if (command === "init") {
    const root = await ensureFlowLayout(cwd);
    console.log(`initialized ${path.relative(process.cwd(), root) || root}`);
    if (flags.demo) {
      const demo = await scaffoldDemoRun(cwd);
      console.log(demo.created ? `demo run ready: ${demo.runId}` : `demo run already exists: ${demo.runId}`);
      printRunLocationDiagnostics(demo.diagnostics);
      console.log("try:");
      console.log(`  flow status ${demo.runId}`);
      console.log(`  flow resume ${demo.runId}`);
      console.log(`  flow console --run ${demo.runId}`);
    }
    return;
  }

  if (command === "validate-definition") {
    const definitionPath = requireArg(args[0], "flow validate-definition requires a definition path");
    const definition = await readDefinitionForValidation(definitionPath, cwd);
    const result = definition.__flowReadError
      ? { valid: false, diagnostics: [definition.__flowReadError] }
      : validateDefinitionWithDiagnostics(definition);
    const payload = validationPayload(definitionPath, result);
    printDefinitionValidation(definitionPath, payload, Boolean(flags.json));
    if (!payload.valid) process.exitCode = 1;
    return;
  }

  if (command === "kit") {
    const action = requireArg(args[0], 'flow kit requires validate, install, or inspect');

    if (action === "validate") {
      const kitPath = requireArg(args[1], "flow kit validate requires a kit directory path");
      const resolvedKit = path.resolve(cwd, kitPath);
      const result = await validateKitContainerFile(resolvedKit);
      const payload = {
        valid: result.valid,
        path: kitPath,
        error_count: result.diagnostics.filter((d) => d.severity === "error").length,
        diagnostics: result.diagnostics
      };
      if (flags.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else if (payload.valid) {
        console.log(`valid Flow Kit container: ${kitPath}`);
      } else {
        console.log(`invalid Flow Kit container: ${kitPath}`);
        for (const d of payload.diagnostics) {
          console.log(`${d.severity.toUpperCase()} ${d.code} ${d.path}: ${d.message}`);
        }
      }
      if (!payload.valid) process.exitCode = 1;
      return;
    }

    if (action === "install") {
      const source = requireArg(args[1], "flow kit install requires a source (git URL, npm spec, or local path)");
      const result = await kitInstall(source, {
        dest: flags.dest ? path.resolve(cwd, flags.dest) : cwd,
        ref: flags.ref
      });
      console.log(`installed kit: ${result.kitId}`);
      console.log(`location: ${result.destPath}`);
      return;
    }

    if (action === "inspect") {
      const kitPath = requireArg(args[1], "flow kit inspect requires a kit directory path");
      const resolvedKit = path.resolve(cwd, kitPath);
      // AGENT-BLIND: reports structural view only — flow ids and declared asset-class NAMES.
      // Does NOT derive K-levels or runtime targets; that is flow-agents' responsibility.
      const result = await kitInspect(resolvedKit);
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.valid) {
          console.log(`kit: ${result.kitId} (${result.kitName})`);
          console.log(`flows: ${result.flows.map((f) => f.id ?? f.path).join(", ")}`);
          if (result.assetClasses.length) {
            console.log(`asset classes: ${result.assetClasses.join(", ")}`);
          } else {
            console.log("asset classes: (none declared)");
          }
        } else {
          console.log("invalid Flow Kit container");
          for (const d of result.diagnostics) {
            console.log(`${d.severity.toUpperCase()} ${d.code} ${d.path}: ${d.message}`);
          }
        }
      }
      if (!result.valid) process.exitCode = 1;
      return;
    }

    throw new Error(`unknown kit action: ${action}\n\nflow kit validate <kit-dir> [--json]\nflow kit install <source> [--dest <path>] [--ref <ref>]\nflow kit inspect <kit-dir> [--json]`);
  }

  if (command === "validate-transition") {
    const requestPath = requireArg(args[0], "flow validate-transition requires a request JSON path");
    const request = JSON.parse(await readFile(path.resolve(cwd, requestPath), "utf8"));
    const result = validateRunTransition(request);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid && result.status === "invalid") process.exitCode = 1;
    return;
  }

  if (command === "config") {
    const action = requireArg(args[0], "flow config requires preview or apply");
    const proposal = requireArg(args[1], `flow config ${action} requires a proposal path`);
    const format = flags.format ?? "summary";
    if (action === "preview") {
      const report = await previewFlowConfigMergeFile(proposal, { cwd });
      printConfigMergeReport(report, format);
      return;
    }
    if (action === "apply") {
      const report = await applyFlowConfigMerge(cwd, proposal, {
        acceptConflicts: flags["accept-conflict"] ?? [],
        exceptionReason: flags["exception-reason"],
        authority: flags.authority
      });
      printConfigMergeReport(report, format);
      if (report.status === "blocked") process.exitCode = 1;
      return;
    }
    throw new Error(`unknown config action: ${action}`);
  }

  if (command === "start") {
    const definition = requireArg(args[0], "flow start requires a definition path");
    const result = await startRun(definition, {
      cwd,
      runId: flags["run-id"],
      params: parseParams(flags.params)
    });
    console.log(`started flow run: ${result.runId}`);
    console.log(`current step: ${result.state.current_step}`);
    console.log(`report: ${runReportPath(result.dir, cwd)}`);
    return;
  }

  if (command === "status") {
    const runId = requireArg(args[0], "flow status requires a run id");
    await printStatus(runId, flags.format ?? "summary", cwd);
    return;
  }

  if (command === "pause" || command === "resume-run" || command === "cancel") {
    const runId = requireArg(args[0], `flow ${command} requires a run id`);
    const request = await readLifecycleRequest(flags, cwd, command);
    const operation = command === "pause" ? pauseRun : command === "resume-run" ? resumeRun : cancelRun;
    const result = await operation(runId, { cwd, ...request });
    printLifecycleResult(runId, result);
    return;
  }

  if (command === "authorize-retry") {
    const runId = requireArg(args[0], "flow authorize-retry requires a run id");
    const request = await readRetryAuthorizationRequest(flags, cwd);
    const result = await authorizeRetry(runId, { cwd, request });
    console.log(`retry authorized${result.idempotent ? " (idempotent)" : ""}: ${runId}`);
    console.log(`target: ${result.state.current_step}`);
    console.log(`epoch: ${result.transition.retry_epoch}`);
    console.log(`request: ${result.transition.authority.request_ref}`);
    return;
  }

  if (command === "amend-definition") {
    const runId = requireArg(args[0], "flow amend-definition requires a run id");
    const [request, definition] = await Promise.all([
      readDefinitionAmendmentRequest(flags, cwd),
      readSuccessorDefinition(flags, cwd)
    ]);
    const result = await amendRunDefinition(runId, { cwd, request, definition });
    console.log(`definition amended: ${runId}`);
    console.log(`prior: ${result.prior_definition.id} v${result.prior_definition.version} ${result.prior_definition.digest}`);
    console.log(`effective: ${result.effective_definition.id} v${result.effective_definition.version} ${result.effective_definition.digest}`);
    console.log(`request: ${result.event.authority.request_ref}`);
    return;
  }

  if (command === "attach-evidence") {
    const runId = requireArg(args[0], "flow attach-evidence requires a run id");
    if (flags["trust-artifact"]) {
      console.error("--trust-artifact is deprecated; use --kind trust.bundle");
    }
    const routeMetadata = await parseRouteMetadata(flags, cwd);
    const entry = await attachEvidence(runId, {
      cwd,
      gate: requireArg(flags.gate, "--gate is required"),
      file: requireArg(flags.file, "--file is required"),
      kind: flags.kind,
      bundle: Boolean(flags.bundle),
      trustArtifact: Boolean(flags["trust-artifact"]),
      status: flags.status,
      supersede: flags.supersede,
      claimType: flags["claim-type"],
      claimSubject: flags["claim-subject"],
      claimStatus: flags["claim-status"],
      producer: flags.producer,
      authorityTrace: flags["authority-trace"],
      route_reason: routeMetadata.route_reason,
      expectation_ids: routeMetadata.expectation_ids,
      classifier: routeMetadata.classifier,
      diagnostics: routeMetadata.diagnostics,
      analytics: routeMetadata.analytics
    });
    console.log(`attached evidence: ${entry.id}`);
    console.log(`gate: ${entry.gate_id}`);
    console.log(`kind: ${entry.kind}`);
    return;
  }

  if (command === "capture") {
    const runId = requireArg(args[0], "flow capture requires a run id");
    const gate = requireArg(flags.gate, "--gate is required");
    const kind = requireArg(flags.kind, "--kind is required");
    if (kind !== "command") throw new Error("flow capture supports only --kind command");
    if (!captureArgv.length) throw new Error("flow capture requires a command after --");
    const run = await loadRun(runId, cwd);
    if (!findGate(run.definition, gate)) throw new Error(`unknown gate: ${gate}`);
    const captured = await captureCommand(captureArgv, { cwd, timeoutMs: parseCaptureTimeout(flags.timeout) });
    let entry;
    try {
      const status = captured.receipt.exit_code === 0 ? "passed" : "failed";
      entry = await attachEvidence(runId, {
        cwd,
        gate,
        file: captured.receiptPath,
        kind: "command",
        status
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail}\ncaptured receipt preserved: ${captured.receiptPath}`);
    }
    await captured.cleanup();
    console.log(`attached evidence: ${entry.id}`);
    console.log(`gate: ${entry.gate_id}`);
    console.log(`kind: ${entry.kind}`);
    console.log(`status: ${entry.status}`);
    console.log(`exit code: ${captured.receipt.exit_code ?? "none"}`);
    if (captured.receipt.exit_code !== 0) {
      process.exitCode = captured.receipt.exit_code && captured.receipt.exit_code > 0
        ? captured.receipt.exit_code
        : 1;
    }
    return;
  }

  if (command === "evaluate") {
    const runId = requireArg(args[0], "flow evaluate requires a run id");
    const result = await evaluateRun(runId, { cwd, gate: flags.gate });
    for (const outcome of result.outcomes) {
      console.log(`${outcome.status} ${outcome.gate_id}: ${outcome.summary}`);
    }
    console.log(`current step: ${result.state.current_step}`);
    console.log(`next action: ${result.state.next_action}`);
    if (flags["exit-code"] && result.outcomes.some((outcome) => outcome.status !== "pass")) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "accept-exception") {
    const runId = requireArg(args[0], "flow accept-exception requires a run id");
    const exception = await acceptException(runId, {
      cwd,
      gate: requireArg(flags.gate, "--gate is required"),
      reason: requireArg(flags.reason, "--reason is required"),
      authority: requireArg(flags.authority, "--authority is required")
    });
    console.log(`accepted exception: ${exception.id}`);
    return;
  }

  if (command === "report") {
    const runId = requireArg(args[0], "flow report requires a run id");
    const format = flags.format ?? "summary";
    const run = await loadRun(runId, cwd);
    const diagnostics = run.diagnostics;
    const report = reportJson(run.definition, run.state, run.manifest);
    const markdown = renderMarkdownReport(run.definition, run.state, run.manifest);
    await repairRunReports(run);
    if (format === "summary") {
      console.log(`${report.status} ${report.summary}`);
      console.log(`report: ${runReportPath(run.dir, cwd)}`);
    } else if (format === "json") {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(markdown);
    }
    printRunLocationDiagnostics(diagnostics);
    return;
  }

  if (command === "version-release-report") {
    const fixturePath = requireArg(args[0], "flow version-release-report requires a fixture JSON path");
    const fixture = JSON.parse(await readFile(path.resolve(cwd, fixturePath), "utf8"));
    const report = projectVersionReleaseReport(fixture);
    const format = flags.format ?? "markdown";
    if (format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else if (format === "markdown") {
      process.stdout.write(renderVersionReleaseReportMarkdown(report));
    } else {
      throw new Error("flow version-release-report --format must be json or markdown");
    }
    return;
  }

  if (command === "console") {
    const runId = requireArg(flags.run ?? args[0], "flow console requires --run <run-id>");
    const port = flags.port === undefined ? 0 : Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
    const server = await startFlowConsoleServer({
      runId,
      cwd,
      host: flags.host ?? "127.0.0.1",
      port
    });
    console.log(`Flow Console: ${server.url}`);
    console.log(`run: ${server.runId}`);
    console.log("Press Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      const stop = async () => {
        await server.close();
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }

  if (command === "ready-steps") {
    const runId = requireArg(args[0], "flow ready-steps requires a run id");
    const run = await loadRun(runId, cwd);
    const ready = readySteps(run.definition, run.state, run.manifest);
    const statuses = stageStatuses(run.definition, run.state, run.manifest);
    if (flags.format === "json") {
      console.log(JSON.stringify({ run_id: runId, readySteps: ready, stageStatuses: statuses }, null, 2));
    } else {
      if (ready.length) {
        console.log(`ready steps: ${ready.join(", ")}`);
      } else {
        console.log("no ready steps");
      }
    }
    return;
  }

  if (command === "resume") {
    const runId = requireArg(args[0], "flow resume requires a run id");
    const run = await loadRun(runId, cwd);
    const ready = readySteps(run.definition, run.state, run.manifest);
    const rendered = renderResume(run.definition, run.state);
    const lines = [rendered];
    if (run.state.status === "paused" && !rendered.includes("resume-run")) {
      lines.push(`run paused; resume it with: flow resume-run ${runId} --request <request-json>\n`);
    }
    if (run.state.status === "canceled" && !/terminal|canceled/i.test(rendered)) {
      lines.push("run canceled; this lifecycle state is terminal\n");
    }
    if (ready.length) lines.push(`ready steps: ${ready.join(", ")}\n`);
    process.stdout.write(lines.join(""));
    return;
  }

  if (command === "list") {
    const { runs, diagnostics } = await listRunsWithDiagnostics(cwd);
    printRunLocationDiagnostics(diagnostics);
    if (!runs.length) {
      console.log("no flow runs found; start one with: flow start <definition> --run-id <id>");
      return;
    }
    for (const run of runs) {
      console.log(`${run.run_id}\t${run.status}\t${run.current_step}\t${run.definition_id} / ${run.subject}`);
    }
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  if (Array.isArray(error?.diagnostics)) {
    for (const diagnostic of error.diagnostics) {
      console.error(`ERROR ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`);
    }
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
