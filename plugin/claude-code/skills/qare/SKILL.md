---
name: qare
description: QA a change with qare. Boots the app against stubbed services, checks acceptance criteria with executed evidence, and lets code decide the verdict. Use before pushing, on a pull request, or whenever a qare verdict, ledger, or plan is asked about.
---

# qare: QA with evidence, decided by code

qare is an external engine, not a persona. You never decide quality
yourself and you never judge evidence: you run qare, then read what it
wrote. Everything in this skill follows the repo constitution
(`CONSTITUTION.md`): verdicts are computed by qare's code, evidence is
produced only by the harness, criteria change only through review, and
every path fails closed.

## Running qare

All engine access goes through the CLI (or the MCP server, or the GitHub
Action). From this plugin you only use the CLI:

- `qare init` — prepare a repo's `.qa/` profile and readiness state.
- `qare run` — plan, execute and judge; writes evidence and `result.json`.
- `qare judge` — re-judge from existing evidence.
- `qare ledger` — inspect or apply the criteria ledger.

If the CLI is not installed, say so and stop; do not approximate qare by
writing checks or verdicts yourself.

## result.json is the machine contract

Every run finishes with a `result.json` inside the job's evidence
directory. It carries:

- `schemaVersion` ("1"), `verdict` (`passed`, `failed`, `blocked`,
  `refused`, or `waived`), and a `criteria` array whose entries are
  `proven`, `failed`, or `unverified` with evidence paths.
- Optional `job.id` and `waived` (array of `{ criterionId, by }`).

Read it; never edit it, and never hand-write one. A hand-written or
edited result is a schema violation, and the hook below treats it as
such.

## Stop hook

The plugin wires a Stop hook (hooks/hooks.json, hooks/stop.mjs). When a
conversation turn ends, the hook reads qare's result.json and maps the
verdict to its exit code:

- `passed` — exit 0, the stop proceeds.
- `failed` — exit 1, named message `QARE_FAILED`; fix the change and
  rerun qare.
- `blocked` — exit 1, named message `QARE_BLOCKED`; fix the run setup.
- `refused` — exit 1, named message `QARE_REFUSED`; read the named
  reason in result.json.
- `waived` — exit 1, named message `QARE_WAIVED`; a human waiver is not
  a pass.
- Missing or malformed result — exit 1 with a named `QARE_RESULT_*`
  error. Fail closed, always.

The hook finds result.json in this order: first CLI argument, then the
`QARE_RESULT_PATH` environment variable, then a `result_path` field in
the hook's stdin JSON, then the default `<project>/.qare/result.json`.
Set `QARE_RESULT_PATH` (or pass the path) when the job's evidence
directory is not `.qare/`.

The hook contains no engine logic. It only reads and shape-validates
result.json; it cannot compute or change a verdict.

## Verifier subagent

After a run, you may ask the read-only `qare-verifier` agent to review
the evidence behind a verdict. Its only permitted outcome changes are
confirmations and downgrades: it may argue that the evidence does not
support a `proven` criterion, which turns that criterion `unverified`.
It never upgrades an outcome and never introduces a verdict; verdicts
stay in qare's code. Criteria themselves change only through review, as
pull requests against the ledger.
