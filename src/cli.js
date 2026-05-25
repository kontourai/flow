#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  acceptException,
  attachEvidence,
  ensureFlowLayout,
  evaluateRun,
  listRuns,
  loadRun,
  renderMarkdownReport,
  renderResume,
  renderSummary,
  reportJson,
  startRun
} from "./index.js";

function usage() {
  return `Usage:
  flow init
  flow start <definition> [--run-id <id>] [--params key=value ...]
  flow status <run-id> [--format summary|json|markdown]
  flow attach-evidence <run-id> --gate <gate> --file <file> [--kind <kind>]
  flow evaluate <run-id> [--gate <gate>]
  flow accept-exception <run-id> --gate <gate> --reason <reason> --authority <authority>
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
    const entry = await attachEvidence(runId, {
      gate: requireArg(flags.gate, "--gate is required"),
      file: requireArg(flags.file, "--file is required"),
      kind: flags.kind,
      status: flags.status
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
