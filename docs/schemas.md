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
  "criteria": [
    { "id": "...", "text": "...", "checks": [ { "kind": "command", "name": "...", "...": "..." } ] },
    { "id": "...", "text": "...", "unplannable": "why this criterion cannot be planned" }
  ]
}
```

| Field | Where | Rules |
| --- | --- | --- |
| `schemaVersion` | document | required, must be `"1"` |
| `criteria` | document | required array; must be non-empty (an empty plan passes nothing, so it fails closed) |
| `id` | criterion | required, non-empty string |
| `text` | criterion | required, non-empty string |
| `checks` | planned criterion | required array, at least one check; mutually exclusive with `unplannable` |
| `unplannable` | criterion | non-empty reason string; mutually exclusive with `checks` |
| `kind` | check | required: `"command"`, `"flow"` or `"visual"` |
| `name` | check | required, non-empty string |
| `inferred` | check | optional boolean; `true` marks a check the model derived without the criterion naming it |

Per-kind required fields (all values are non-empty strings):

| Kind | Field | Rules |
| --- | --- | --- |
| `command` | `command` | the shell command the harness runs |
| `flow` | `suite` or `actions` | exactly one: an existing suite name, or a fixed action set of typed actions |
| `visual` | `screenshot` | named screenshot to capture |
| `visual` | `widths`, `themes` | optional arrays of numbers / of strings; profile defaults apply when omitted |

A flow action is one of `{"action": "open", "url": "..."}`, `{"action": "type", "element": ..., "value": "..."}`, `{"action": "click", "element": ...}` and `{"action": "assert", "text": "..."}`. An element reference is `{"role": "...", "name": "..."}` or `{"testId": "..."}` — semantic, never a selector. Free-form strings are rejected when the plan loads.

## result.json (schemaVersion "1")

The run's output and the machine contract other harnesses consume.

```json
{
  "schemaVersion": "1",
  "verdict": "passed",
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
