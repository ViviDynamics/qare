# The orchestrator contract

How an orchestrator — a harness, a GitHub Action, another agent — runs QARE and
reacts to what it did. A worked example that implements this contract with
nothing but Node builtins lives in
[`examples/orchestrator.mjs`](../examples/orchestrator.mjs).

## Invocation

```
qare run --job <path|->       # --job - reads the job from stdin
```

The job is the caller's own input (see "A job handed in" in
[SPEC.md](./SPEC.md)); it names the `evidenceDir` the caller wants evidence
written to. On every run that reaches a verdict, the CLI prints
`verdict <verdict>; evidence <evidenceDir>` to stdout.

`qare judge --result <path>` turns a result.json into a PR comment and check
run; on success it exits 0 whatever the verdict was. Gating — deciding whether
the work passed — is `qare run`'s exit code and result.json, never the judge.

## result.json

A completed run always writes a result, even when the verdict is failure:

| Location | `<evidenceDir>/result.json` |
| --- | --- |

The schema is pinned at `schemaVersion: "1"` and is documented field by field
in [schemas.md](./schemas.md); the strict loaders are
`loadResult`/`parseResult` in `@qare/core`. `job.id` echoes the caller's job
id, and a `waived` run carries the `waived` array naming who waived what.

**Pinning.** `"1"` is the only version the loaders understand. A missing or
unknown `schemaVersion` fails closed with a named error — the loader never
guesses or widens. An orchestrator must check the version the same way before
reading anything else out of the document; the worked example does.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | verdict `passed` |
| 1 | verdict `failed` |
| 2 | verdict `blocked` |
| 3 | verdict `refused` |
| 4 | the harness never reached a verdict: invalid job file, unreadable path, missing `--job` from `qare run`, or a `qare judge` failure. Do not treat it as a verdict |
| 5 | verdict `waived` |

Exit codes 0–3 and 5 mean the harness ran and decided; 4 means the harness never
got to decide. Do not rely on the exit code alone: read result.json from the
evidence directory and check its `schemaVersion`, then react to the verdict.

## Evidence directory layout

The evidence directory holds everything a run produced:

```
<evidenceDir>/
  result.json                      # the machine contract, at the root
  checks/<criterion id>/<n>/       # one directory per executed check
    stdout.txt
    stderr.txt
```

Every executed check captures its stdout and stderr there, and the result's
`criteria[].evidence` arrays name those files. Evidence references are
relative paths that stay inside the evidence directory: absolute paths and
any `..` segment are rejected by the loaders. An orchestrator reads evidence
files relative to the `evidenceDir` it named in the job.

## Verdict → reaction

| Verdict | Exit | The orchestrator reacts |
| --- | --- | --- |
| `passed` | 0 | Proceed. Every criterion is proven; the evidence paths in result.json are what it is proven by. |
| `failed` | 1 | Fail, naming the criteria whose outcome is `failed`. A code defect was found. |
| `blocked` | 2 | Fail closed, but not as a defect: name the environment reason from each `unverified` criterion and let the caller retry. |
| `refused` | 3 | Fail closed: the run refused for a named reason (missing stub, missing QA profile). File the stub work; do not ship. |
| `waived` | 5 | Fail closed. A human waiver is recorded (`waived[].criterionId`, `waived[].by`); a waiver is never a pass. |

Anything else — malformed JSON, an unknown `schemaVersion`, a verdict outside
the five — is a harness problem, not a verdict: fail closed with a named error
and do not proceed.

## The worked example

```
node examples/orchestrator.mjs <job-file> <evidence-dir>
```

It runs `qare run --job <job-file>` (set `QARE_BIN` to point at a specific
`qare` binary), reads `<evidence-dir>/result.json` strictly, and reacts per
the table above: prints evidence paths on `passed`, names failed criteria on
`failed`, names reasons on `blocked`/`refused`, refuses to pass a `waived`
run, and exits 4 for anything that is not a result. Its tests live in
`examples/test/orchestrator.test.mjs` and
`packages/cli/test/orchestrator.test.ts` (which feeds it a real `qare run`'s
result.json).
