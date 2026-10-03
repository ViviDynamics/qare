# plan.json and result.json schemas

These two documents are the machine contracts between the QARE jobs, and
between QARE and any other harness. Both are validated by loaders in
`@qare/core` (`packages/core`): `loadPlan`/`parsePlan` for plan.json and
`loadResult`/`parseResult` for result.json. The `load*` functions take raw
JSON text; the `parse*` functions take an already-parsed value. Anything that
violates the schema throws a named error — `PlanValidationError` or
`ResultValidationError` — whose `field` property carries the exact offending
path (for example `criteria[0].checks[0].kind`), and whose message names what
was expected. Both loaders fail closed: when in doubt they reject, never guess.

Unknown extra keys are ignored for forward compatibility; known keys are
validated strictly, as documented below.

## schemaVersion policy

Both documents carry `schemaVersion: "1"`. The exported constants
`PLAN_SCHEMA_VERSION` and `RESULT_SCHEMA_VERSION` are the single knobs: a
loader understands exactly the version it declares. A missing or unknown
version fails closed — the loader never guesses or widens. If a schema needs a
breaking change, it bumps the version, ships the new loader, and lets the old
loader reject the new documents rather than silently accepting a mix.

## plan.json (schemaVersion "1")

The plan step's output: every acceptance criterion, mapped either to the checks
that can settle it or to a reason it cannot be planned.

```json
{
  "schemaVersion": "1",
  "usage": { "inputTokens": 900, "outputTokens": 120 },
  "criteria": [
    { "id": "...", "text": "...", "checks": [ { "kind": "command", "name": "...", "...": "..." } ] },
    { "id": "...", "text": "...", "unplannable": "why this criterion cannot be planned" }
  ]
}
```

| Field | Where | Rules |
| --- | --- | --- |
| `schemaVersion` | document | required, must be `"1"` |
| `usage` | document | optional object with `inputTokens` and `outputTokens` (numbers, at least 0): what the planning model spent planning (#51) |
| `criteria` | document | required array; must be non-empty (an empty plan passes nothing, so it fails closed) |
| `id` | criterion | required, non-empty string |
| `text` | criterion | required, non-empty string |
| `checks` | planned criterion | required array, at least one check; mutually exclusive with `unplannable` |
| `unplannable` | criterion | non-empty reason string; mutually exclusive with `checks` |
| `kind` | check | required: `"command"`, `"flow"`, `"visual"`, `"mail"` or `"tool"` |
| `name` | check | required, non-empty string |
| `inferred` | check | optional boolean; `true` marks a check the model derived without the criterion naming it |

Per-kind required fields (all values are non-empty strings):

| Kind | Field | Rules |
| --- | --- | --- |
| `command` | `command` | the shell command the harness runs |
| `flow` | `suite` or `actions` | exactly one: an existing suite name, or a fixed action set of typed actions |
| `visual` | `screenshot` | what the screenshot is called in the evidence |
| `visual` | `url` | optional: the page to capture, a path on the app or a URL; the app's root when omitted (#143) |
| `visual` | `widths`, `themes` | optional arrays of whole pixel widths (1 to 10000) / of strings; the profile's `visual` section applies when omitted. Themes become evidence file names, so they carry no path separators |

A flow action is one of `{"action": "open", "url": "..."}`, `{"action": "type", "element": ..., "value": "..."}`, `{"action": "click", "element": ...}` and `{"action": "assertText", "text": "..."}`. An element reference is `{"role": "...", "name": "..."}` or `{"testId": "..."}` — semantic, never a selector. Free-form strings are rejected when the plan loads.

## result.json (schemaVersion "1")

The run's output and the machine contract other harnesses consume.

```json
{
  "schemaVersion": "1",
  "verdict": "passed",
  "environment": {
    "execution": "native",
    "versions": { "qare": "2026.9.0", "node": "24.5.0", "nareContract": 1 }
  },
  "criteria": [
    { "id": "...", "outcome": "proven", "evidence": ["evidence/..."] },
    { "id": "...", "outcome": "failed", "evidence": ["evidence/..."] },
    { "id": "...", "outcome": "unverified", "reason": "why no check ran", "evidence": ["evidence/..."] }
  ]
}
```

| Field | Where | Rules |
| --- | --- | --- |
| `schemaVersion` | document | required, must be `"1"` |
| `verdict` | document | required: `"passed"`, `"failed"`, `"blocked"`, `"refused"` or `"waived"` |
| `criteria` | document | required array (may be empty: a `refused` or `waived` run legitimately carries zero per-criterion outcomes) |
| `id` | criterion result | required, non-empty string |
| `outcome` | criterion result | required: `"proven"`, `"failed"` or `"unverified"` |
| `evidence` | proven / failed | required, non-empty array of relative paths — a criterion is proven or failed only by evidence |
| `reason` | unverified | required, non-empty string — why no check ran |
| `reason` | failed | optional, non-empty string — present when judge failed a criterion its check proved (the verifier), saying why |
| `evidence` | unverified | optional array of relative paths |
| `job` | document | optional; when present `job.id` is required non-empty — the caller's job id, echoed back |
| `waived` | document | optional non-empty array of `{ criterionId, by }` — the human waiver record a `waived` run carries |
| `target` | document | optional; present when the run checked an app qare did not boot. `target.url` is required non-empty and `target.comparison` must be `"none"`: nothing ran at a base revision, so no regression was looked for |
| `base` | document | optional (#147); present when the run was asked to check the base revision too. `base.ref` is the job's base ref, `base.status` is `"executed"` or `"not-executed"`, and a base that did not execute carries a non-empty `base.reason` (no checkout, no profile, a boot that never came up, a profile that runs nothing there) |
| `base` | criterion result | optional (#147): what the base showed for this criterion. `base.outcome` is `"proven"`, `"failed"` or `"not-compared"`; `not-compared` carries a non-empty `base.reason`; `base.evidence` is an optional array of relative paths under `base/`. Not compared is never passed |
| `regression` | criterion result | optional boolean (#147), decided in code from the executed outcomes of both sides. `true`: the base proved the criterion and the head did not (rejected unless `base.outcome` is `"proven"` and the criterion is not `proven`). `false`: it failed at the base too, so it is behaviour that does not work yet (rejected unless `base.outcome` is `"failed"`). Absent: nothing was compared, or nothing failed |
| `environment` | document | optional; when present `environment.execution` is `"native"` or `"containerised"`, and `environment.versions` carries `qare`, `node` (non-empty strings) and `nareContract` (number): where the run executed and with which versions |
| `startedAt` / `finishedAt` | document | optional ISO 8601 timestamps (#51): when the run started and when its result was written. Written together by the run step; a result that carries one without the other is rejected |
| `judgeUsage` | document | optional `{ inputTokens, outputTokens }` (numbers, at least 0) (#51): what the verifier model spent judging the run. Written by the judge step onto `judged-result.json`, and carried through a re-judge |

## The metrics store (schemaVersion "qare.metrics.v1")

What the runs amount to over time (#51), stored as data in the repository: one
JSON line per run in `metrics/runs.jsonl`, and one per human note in
`metrics/notes.jsonl`, both under the ledger directory. Written by
`qare metrics record` (which joins a judged result's wall clock and verdict
with the plan's and verifier's model spend) and `qare metrics note` (which
records what the runs cannot see: a defect that escaped to production, a
block that was wrong, the minutes a person spent on QA that QARE did not).
The sweep joins every record the pipeline pushed to the `qa-assets` branch
and reports the totals in the standing issue.

A run record line:

```json
{
  "schemaVersion": "qare.metrics.v1",
  "runId": "...",
  "recordedAt": "2026-09-29T00:00:00.000Z",
  "startedAt": "2026-09-29T00:00:00.000Z",
  "finishedAt": "2026-09-29T00:00:00.000Z",
  "wallMs": 0,
  "verdict": "passed",
  "criteria": { "selected": [{ "id": "...", "outcome": "proven" }], "counts": { "proven": 1 } },
  "model": { "plan": { "inputTokens": 0, "outputTokens": 0 }, "judge": { "inputTokens": 0, "outputTokens": 0 } },
  "context": { "pr": 1, "base": "...", "head": "..." }
}
```

| Field | Where | Rules |
| --- | --- | --- |
| `schemaVersion` | document | required, must be `"qare.metrics.v1"` |
| `runId` | document | required non-empty: the job id the pipeline gave the run |
| `recordedAt`, `startedAt`, `finishedAt` | document | required ISO 8601 timestamps |
| `wallMs` | document | required non-negative number: the run's wall clock, finished minus started |
| `verdict` | document | required, one of the run verdicts |
| `criteria.selected` | document | required array of `{ id, outcome }`: what the run checked and how each came out |
| `criteria.counts` | document | required object: the same outcomes, counted |
| `model` | document | optional `{ plan?, judge? }`; each side optional `{ inputTokens, outputTokens }` numbers. Absent when a step ran without a model |
| `context` | document | optional `{ pr?, base?, head? }`: where the run happened, when the caller says |

A note line carries `schemaVersion`, `recordedAt`, a `kind` of `"escape"`,
`"false-block"` or `"qa-minutes"`, and per kind: `text` (what the note says),
`minutes` (a positive number, only for `"qa-minutes"`), `criterion` and
`runId` (what the note belongs to, when it names one). A reader that finds a
store line it cannot parse skips it and names the count, never fails: metrics
describe runs, they do not gate them.

## Fail-closed rules shared by both loaders

- The document must be a JSON object; non-JSON text is rejected with a named
  error, never silently treated as empty.
- `schemaVersion` must be present and known.
- Every violation names its field: the error's `field` is the exact path (for
  example `criteria[1].checks[0].kind`), so the producing job can point at the
  offending line.
- Evidence paths must be relative and stay inside the evidence directory:
  absolute paths (`/...`, drive letters), UNC paths (`\\host\share`,
  `//host/share`) and any `..` segment are rejected.
