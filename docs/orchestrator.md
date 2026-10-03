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

`qare check "<criterion>"... [--profile <dir>] [--evidence <dir>]` plans,
runs and judges criteria stated in plain words in one call (see "A criterion
in a sentence" in [SPEC.md](./SPEC.md)). It writes the same `result.json`, plus
`plan.json` and `judged-result.json`, and exits with the code below for the
judged verdict, so an orchestrator can gate on either command.

`qare judge --result <path>` turns a result.json into a PR comment and check
run; on success it exits 0 whatever the verdict was. Gating — deciding whether
the work passed — is `qare run`'s exit code and result.json, never the judge.

By default judge also puts every proven criterion to the verifier model
through nare, which needs `--plan <path>` for the criteria text and
`--diff <path>`; `--runner none` judges from the evidence alone. The verifier
can only downgrade: a finding fails its criterion with the reason recorded,
and a verifier that gives no readable answer leaves the criterion unverified,
so the run blocks rather than passing unchecked.

Everything judge writes is published, so it redacts the reasons in it, with
the built-in rules and, given `--profile <dir>`, the profile's `redact` values
and patterns too.

After the verdict is computed judge also asks the model for an advisory UX
review of the screens the run's flows drove (#150), unless `--runner none` is
given or the profile's `ux.review` is `false`. Its findings land under
`advisory` in `judged-result.json` and in a section of the comment marked
advisory. They are a model's opinion for a person to read: an orchestrator
must not gate on them, and nothing in the verdict, the check run or any exit
code depends on them. `--dismissed <path>` names the findings a person
already dismissed on the change, so they are not raised again.

`qare reap` tears down compose projects qare booted (#53). With project names
(`qare reap qare-<run id>`), exactly those are downed and a name that is not
qare's is refused, so the orchestrator can reap the run that just died while
its other runs stay live. With no names, it is the quiescent sweep: every
running project named `qare-*` is downed, active or not, so it belongs when no
qare run is left working — after a crash that took the queue down, or after
everything was canceled. It exits 4 if any project could not go down, naming
each on stderr. Projects that are not qare's are never touched.

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
  isolation.json                   # an app run: the compose project, run id and port it booted under (#53)
  provision.log                    # what provisioning did (#75): a client build's install, health check and removal; or what a boot that blocked said
  checks/<criterion id>/<n>/       # one directory per executed check
    stdout.txt
    stderr.txt
    command.json                   # a command check: the command as run, its outcome and exit code
    selected.txt                   # a filtered command whose report was read: the tests the filter selected (#157)
    outbound.json                  # a flow on a target run: every host its browser reached
    console.log                    # a flow in a browser or a client build (#72, #78): what the page or the application wrote, and its windows
    failure.log                    # a flow that did not pass (#78): the part of console.log around the moment it stopped
    recording.png                  # a flow that did not pass (#78): its screen recording, an animated PNG
    assert-<n>.json                # a flow's assertion (#82): the accessibility tree where it was made
```

A run against a target (a profile naming `target` rather than `app`) carries
`target: { url, comparison: "none" }` in result.json: nothing ran at a base
revision, so no regression was looked for.

`qare run` on a profile that boots an app checks both sides (#147): the same
plan against the app booted from `baseRef`, then against the head. A client
profile that names a build of the base (`client.artefact.base`, #75) has both
sides too: the base build is installed and checked, then the head build, and
`client.comparison` in the result is `"base"`. Each side
keeps a directory of its own, laid out as above, and the root `result.json` is
the comparison of the two:

```
<evidenceDir>/
  result.json                      # the head's outcomes and verdict, plus what the base showed
  base/                            # the base side: result.json, isolation.json, checks/...
  head/                            # the head side: result.json, isolation.json, checks/...
```

Evidence paths in the root result carry their side (`head/checks/...`), and
each criterion names what the base showed in `base` (`proven`, `failed`, or
`not-compared` with the reason) with the base's evidence under `base/`. A
failed criterion the base proved carries `regression: true`; one that failed
at the base too carries `regression: false`; one that was not compared carries
neither. The root `base` says which ref was checked and whether it executed.
The verdict and the exit code are the head's, as they always were: the base
side only tells a regression from a failure that is new.

The base tree is a checkout you already have (`qare run --base-repo <dir>`),
or a detached git worktree of `baseRef` the run makes and removes. With
neither (no git, a ref that names no commit, the same revision on both sides)
the head is still checked, the root `base` is `not-executed` naming why, and
stderr says so. The base's app is stopped before the head boots; the head's is
left up for you, as on a one-sided run.

Every executed check captures its stdout and stderr there, and the result's
`criteria[].evidence` arrays name those files; a command check also records
`command.json`: the command as run, its outcome, and the exit code it closed. A
check whose profile command declares a filter and a report format is verified
against the command's own report (#157): an exit of 0 is not enough, because a
filter that selected nothing (or the whole suite) exercises the criterion only
by accident. The runner reads the report from stdout, counts the tests the
filter selected, and downgrades the check to unverified naming the filter and
the counts when the selection is empty or total, so a whole-suite run cannot
prove a filtered criterion; the selected names are saved to `selected.txt`. A
command with no declared filter is unaffected: exit 0 proves it as before.
Evidence references are
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

## Regressions on main

A criterion that passed before and fails in a run on the default branch is
filed as an issue labelled `qa-regression` (see "Findings on main" in
[SPEC.md](./SPEC.md)). That label is the hand-off: an orchestrator picks up
open issues that carry it. The issue names the criterion, the evidence, the
commits since the criterion last passed and the pull request the evidence
points at. qare does not fix the regression and does not merge anything; it
comments on the issue while the criterion still fails and closes it when a
run proves the criterion again, so an orchestrator need not close it.

`qa-environment` (nothing could boot or be reached) and `qa-failure` (a
failure nothing shows ever passed) are not hand-offs: neither names a change
to undo.

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
