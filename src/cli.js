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
  renderConfigMergeMarkdown,
  renderConfigMergeSummary,
  renderMarkdownReport,
  renderResume,
  renderSummary,
  reportJson,
  startRun,
  validateDefinitionWithDiagnostics
} from "./index.js";

function usage() {
  return `Usage:
  flow init
  flow validate-definition <path> [--json]
  flow start <definition> [--run-id <id>] [--params key=value ...]
  flow status <run-id> [--format summary|json|markdown]
  flow attach-evidence <run-id> --gate <gate> --file <file> [--kind <kind>] [--claim-type <type>] [--claim-subject <subject>] [--claim-status <status>] [--producer <id>] [--authority-trace <trace>] [--route-reason <reason>] [--classifier-kind <kind>] [--classifier-source <source>] [--classifier-confidence <0..1>] [--analytics-loop-key <key>] [--expectation-id <id> ...] [--route-metadata <json-file>]
  flow evaluate <run-id> [--gate <gate>]
  flow accept-exception <run-id> --gate <gate> --reason <reason> --authority <authority>
  flow config preview <proposal> [--format summary|markdown|json]
  flow config apply <proposal> [--accept-conflict <path> ...] [--exception-reason <reason>] [--authority <authority>] [--format summary|markdown|json]
  flow report <run-id> [--format summary|markdown|json]
  flow resume <run-id>
  flow list
`;
}

function parseArgs(argv) {
  const args = [];
  const flags = {};
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
    if (key === "expectation-id" || key === "accept-conflict") {
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

function parseParams(values = []) {
  const params = {};
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

async function parseRouteMetadata(flags) {
  const metadataFile = flags["route-metadata"] ?? flags.metadata;
  const fileMetadata = metadataFile
    ? JSON.parse(await readFile(path.resolve(process.cwd(), metadataFile), "utf8"))
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

async function printStatus(runId, format) {
  const run = await loadRun(runId);
  if (format === "json") {
    console.log(JSON.stringify(reportJson(run.definition, run.state, run.manifest), null, 2));
  } else if (format === "markdown") {
    process.stdout.write(renderMarkdownReport(run.definition, run.state, run.manifest));
  } else {
    process.stdout.write(renderSummary(run.definition, run.state));
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

async function readDefinitionForValidation(definitionPath) {
  const resolved = path.resolve(process.cwd(), definitionPath);
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

  if (command === "init") {
    const root = await ensureFlowLayout();
    console.log(`initialized ${path.relative(process.cwd(), root) || root}`);
    return;
  }

  if (command === "validate-definition") {
    const definitionPath = requireArg(args[0], "flow validate-definition requires a definition path");
    const definition = await readDefinitionForValidation(definitionPath);
    const result = definition.__flowReadError
      ? { valid: false, diagnostics: [definition.__flowReadError] }
      : validateDefinitionWithDiagnostics(definition);
    const payload = validationPayload(definitionPath, result);
    printDefinitionValidation(definitionPath, payload, Boolean(flags.json));
    if (!payload.valid) process.exitCode = 1;
    return;
  }

  if (command === "config") {
    const action = requireArg(args[0], "flow config requires preview or apply");
    const proposal = requireArg(args[1], `flow config ${action} requires a proposal path`);
    const format = flags.format ?? "summary";
    if (action === "preview") {
      const report = await previewFlowConfigMergeFile(proposal);
      printConfigMergeReport(report, format);
      return;
    }
    if (action === "apply") {
      const report = await applyFlowConfigMerge(proposal, {
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
    await printStatus(runId, flags.format ?? "summary");
    return;
  }

  if (command === "attach-evidence") {
    const runId = requireArg(args[0], "flow attach-evidence requires a run id");
    const routeMetadata = await parseRouteMetadata(flags);
    const entry = await attachEvidence(runId, {
      gate: requireArg(flags.gate, "--gate is required"),
      file: requireArg(flags.file, "--file is required"),
      kind: flags.kind,
      status: flags.status,
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
    const result = await evaluateRun(runId, { gate: flags.gate });
    for (const outcome of result.outcomes) {
      console.log(`${outcome.status} ${outcome.gate_id}: ${outcome.summary}`);
    }
    console.log(`current step: ${result.state.current_step}`);
    console.log(`next action: ${result.state.next_action}`);
    return;
  }

  if (command === "accept-exception") {
    const runId = requireArg(args[0], "flow accept-exception requires a run id");
    const exception = await acceptException(runId, {
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
    if (format === "summary") {
      const report = JSON.parse(await readFile(path.join(".flow", "runs", runId, "report.json"), "utf8"));
      console.log(`${report.status} ${report.summary}`);
      console.log(`report: .flow/runs/${runId}/report.md`);
    } else if (format === "json") {
      process.stdout.write(await readFile(path.join(".flow", "runs", runId, "report.json"), "utf8"));
    } else {
      process.stdout.write(await readFile(path.join(".flow", "runs", runId, "report.md"), "utf8"));
    }
    return;
  }

  if (command === "resume") {
    const runId = requireArg(args[0], "flow resume requires a run id");
    const run = await loadRun(runId);
    process.stdout.write(renderResume(run.definition, run.state));
    return;
  }

  if (command === "list") {
    const runs = await listRuns();
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
