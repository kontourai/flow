# Agent Hooks

Flow's promise is that agents cannot silently skip required gates — but Flow does not run agents, so the enforcement point lives in the agent runtime. This guide shows minimal, copyable recipes for wiring Flow gates into the harnesses teams already use. Everything here uses only the stock CLI; the wrapper script below was verified against a real run.

These are hand-rolled recipes by design. [Flow Agents](https://kontourai.io/flow-agents) is the Kontour product that packages this pattern properly — kits, runtime adapters, and managed hooks across harnesses. Use these recipes when you want the contract today with zero extra dependencies.

## The one-liner that makes it work

`flow evaluate --exit-code` exits `1` unless every evaluated gate passed:

```sh
npx flow evaluate dev-1847 --exit-code
```

That single property lets any system that understands exit codes — agent hooks, CI jobs, Git hooks, Makefiles — enforce a Flow gate.

## Claude Code: block stopping while gates are open

Claude Code runs `Stop` hooks when the agent wants to finish its turn; a hook that exits `2` blocks the stop and feeds its stderr back to the agent. Combined with `flow resume`, the agent that tried to stop early gets told exactly where the run actually stands:

```sh
# .flow/hooks/require-gates.sh
#!/bin/sh
run_id="${FLOW_RUN_ID:-demo}"
if ! npx flow evaluate "$run_id" --exit-code >/dev/null 2>&1; then
  npx flow resume "$run_id" >&2
  exit 2
fi
```

```json
// .claude/settings.json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "sh .flow/hooks/require-gates.sh" }
        ]
      }
    ]
  }
}
```

With an open gate, the blocked stop looks like this to the agent (real output):

```text
flow run: agent-dev-flow / feature-search-filters
current step: implement
next action: attach evidence for implementation gate
open gates: implement-gate
accepted exceptions: none
route backs: none
guidance: continue from recorded Flow state; attach evidence for implementation gate
```

The agent cannot summarize its way past the gate: it either attaches the evidence the gate expects, or a human records an explicit exception with `flow accept-exception`.

Set `FLOW_RUN_ID` per project or per task (for example in `.claude/settings.json` `env`, or exported by the script that starts the run) so the hook checks the run the agent is actually working on.

## Claude Code: gate risky tool calls

A `PreToolUse` hook that exits `2` blocks the tool call. To stop an agent from pushing before the verify gate passes:

```json
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(git push*)",
        "hooks": [
          { "type": "command", "command": "sh .flow/hooks/require-gates.sh" }
        ]
      }
    ]
  }
}
```

The same wrapper works for both events because the contract is the same: gates open → non-zero → blocked, with `flow resume` explaining why.

## GitHub Actions: gates as a required check

Definitions validate cleanly in CI because `flow validate-definition` exits non-zero on invalid input:

```yaml
- name: Validate Flow Definitions
  run: npx --yes @kontourai/flow validate-definition .flow/definitions/agent-dev-flow.json --json
```

When the run directory travels with the work — committed alongside a change, or uploaded as a workflow artifact by the job that produced the evidence — the gate check is the same one-liner:

```yaml
- name: Require Flow gates
  run: npx --yes @kontourai/flow evaluate "$FLOW_RUN_ID" --exit-code
  env:
    FLOW_RUN_ID: dev-1847
```

Make the job a required status check and a pull request cannot merge while the run has open gates — without Flow knowing anything about GitHub.

## Git pre-push, Makefiles, anything with an exit code

```sh
# .githooks/pre-push (or a Makefile target, or a release script)
npx flow evaluate "$FLOW_RUN_ID" --exit-code || {
  npx flow resume "$FLOW_RUN_ID"
  echo "flow gates are open; attach evidence or record an exception" >&2
  exit 1
}
```

## Boundaries

These recipes deliberately stay inside Flow's v0.1 boundary: the hook scripts are project tooling you own, Flow only evaluates its recorded contracts, and nothing here dispatches agents or calls hosted services. When you outgrow hand-rolled hooks — multiple harnesses, kit distribution, managed installs — that is exactly the surface [Flow Agents](https://kontourai.io/flow-agents) owns.
