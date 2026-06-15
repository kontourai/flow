#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  acceptException,
  applyFlowConfigMerge,
  attachEvidence,
  ensureFlowLayout,
  evaluateRun,
  listRuns,
  loadRun,
  previewFlowConfigMergeFile,
  projectVersionReleaseReport,
  renderConfigMergeMarkdown,
  renderConfigMergeSummary,
  renderMarkdownReport,
  renderResume,
  renderSummary,
  renderVersionReleaseReportMarkdown,
  reportJson,
  runDir,
  scaffoldDemoRun,
  startRun,
  validateRunTransition,
  readySteps,
  stageStatuses,
  validateDefinitionWithDiagnostics
} from "./index.js";
import { startFlowConsoleServer } from "./console/console-server.js";
import { validateKitContainerFile } from "./kit/flow-kit-container.js";

type CliFlags = Record<string, any>;

function usage() {
  return `Usage:
  flow init [--demo] [--cwd <path>]
  flow validate-definition <path> [--json] [--cwd <path>]
  flow validate-kit <kit-dir> [--json] [--cwd <path>]
  flow validate-transition <request-json> [--cwd <path>]
  flow start <definition> [--run-id <id>] [--params key=value ...] [--cwd <path>]
  flow status <run-id> [--format summary|json|markdown] [--cwd <path>]
  flow attach-evidence <run-id> --gate <gate> --file <file> [--kind <kind>] [--supersede <evidence-id> ...] [--trust-artifact] [--claim-type <type>] [--claim-subject <subject>] [--claim-status <status>] [--producer <id>] [--authority-trace <trace>] [--route-reason <reason>] [--classifier-kind <kind>] [--classifier-source <source>] [--classifier-confidence <0..1>] [--analytics-loop-key <key>] [--expectation-id <id> ...] [--route-metadata <json-file>] [--cwd <path>]
  flow evaluate <run-id> [--gate <gate>] [--exit-code] [--cwd <path>]
  flow accept-exception <run-id> --gate <gate> --reason <reason> --authority <authority> [--cwd <path>]
  flow config preview <proposal> [--format summary|markdown|json] [--cwd <path>]
  flow config apply <proposal> [--accept-conflict <path> ...] [--exception-reason <reason>] [--authority <authority>] [--format summary|markdown|json] [--cwd <path>]
  flow report <run-id> [--format summary|markdown|json] [--cwd <path>]
  flow version-release-report <fixture-json> [--format json|markdown] [--cwd <path>]
  flow console --run <run-id> [--cwd <path>] [--host 127.0.0.1|localhost|::1] [--port <port>]
  flow resume <run-id> [--cwd <path>]
  flow list [--cwd <path>]
  flow ready-steps [<run-id>] [--format json] [--cwd <path>]
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
  if (format === "json") {
    const base = reportJson(run.definition, run.state, run.manifest);
    const ready = readySteps(run.definition, run.state, run.manifest);
    const statuses = stageStatuses(run.definition, run.state, run.manifest);
    console.log(JSON.stringify({ ...base, readySteps: ready, stageStatuses: statuses }, null, 2));
  } else if (format === "markdown") {
    process.stdout.write(renderMarkdownReport(run.definition, run.state, run.manifest));
  } else {
    const ready = readySteps(run.definition, run.state, run.manifest);
    process.stdout.write(renderSummary(run.definition, run.state));
    if (ready.length) {
      process.stdout.write(`ready steps: ${ready.join(", ")}\n`);
    }
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

  const { args, flags } = parseArgs(rest);
  const cwd = resolveCliCwd(flags);

  if (command === "init") {
    const root = await ensureFlowLayout(cwd);
    console.log(`initialized ${path.relative(process.cwd(), root) || root}`);
    if (flags.demo) {
      const demo = await scaffoldDemoRun(cwd);
      console.log(demo.created ? `demo run ready: ${demo.runId}` : `demo run already exists: ${demo.runId}`);
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

  if (command === "validate-kit") {
    const kitPath = requireArg(args[0], "flow validate-kit requires a kit directory path");
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
    console.log(`report: .flow/runs/${result.runId}/report.md`);
    return;
  }

  if (command === "status") {
    const runId = requireArg(args[0], "flow status requires a run id");
    await printStatus(runId, flags.format ?? "summary", cwd);
    return;
  }

  if (command === "attach-evidence") {
    const runId = requireArg(args[0], "flow attach-evidence requires a run id");
    const routeMetadata = await parseRouteMetadata(flags, cwd);
    const entry = await attachEvidence(runId, {
      cwd,
      gate: requireArg(flags.gate, "--gate is required"),
      file: requireArg(flags.file, "--file is required"),
      kind: flags.kind,
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
    const dir = runDir(runId, cwd);
    if (format === "summary") {
      const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
      console.log(`${report.status} ${report.summary}`);
      console.log(`report: .flow/runs/${runId}/report.md`);
    } else if (format === "json") {
      process.stdout.write(await readFile(path.join(dir, "report.json"), "utf8"));
    } else {
      process.stdout.write(await readFile(path.join(dir, "report.md"), "utf8"));
    }
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
    const lines = [renderResume(run.definition, run.state)];
    if (ready.length) lines.push(`ready steps: ${ready.join(", ")}\n`);
    process.stdout.write(lines.join(""));
    return;
  }

  if (command === "list") {
    const runs = await listRuns(cwd);
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
  console.error(error.message);
  process.exitCode = 1;
});
