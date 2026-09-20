# qare constitution

Rules that hold for every change in this repository. Everything else is a
preference; these are not.

## 1. nare is the agent harness

Every model call qare makes goes through
[nare](https://github.com/ViviDynamics/nare). qare does not call a model
provider SDK, and does not embed a second agent loop.

qare owns QA: profiles, booting, checks, evidence, verdicts, and the GitHub
surfaces. nare owns talking to models: the loop, tools, approval, events,
sessions, and transports. nare must stay generic enough that a caller with
nothing to do with QA would want it, so nothing qare-shaped may land there,
including a flag named for a qare concept. When a change would teach qare about
providers, tokens, retries, or tool protocols, it belongs in nare instead.

nare is a separate process. qare invokes it and consumes its typed JSONL
events and session files.

## 2. A gap in nare becomes an issue on nare

When qare is blocked because nare cannot do something, the answer is never to
work around it inside qare. Specifically, never:

- call a provider SDK directly, "just for now"
- shell out to another agent CLI
- parse prose where a typed event should exist
- fork or vendor nare source into this repo

Do this instead:

1. Open an issue on `ViviDynamics/nare` describing the capability in nare's own
   vocabulary: a caller, a session, a tool, a transport, a contract. Never
   qare's: no criteria, no evidence, no verdicts, no pull requests. Ask for the
   general capability that qare happens to need, so any caller can use it, and
   link the qare issue at the bottom as provenance rather than as the rationale.
   If a request cannot be stated without qare's words, it is a qare feature
   wearing nare's clothes, and it stays here.
2. Link that nare issue from the blocked qare issue, and set the qare issue to
   Blocked on the board.
3. If qare can make progress behind an interface while the nare work lands, do
   that, and keep the interface as the only seam.

A temporary shim that reaches past nare is a constitution violation even when
it works, because it removes the pressure that makes nare good.

## 3. The model plans and witnesses; code decides

A model may write the check plan, describe what it sees, and argue that
evidence does not support a criterion. Verdicts are computed by qare's code
from executed results. No model output sets a verdict, and no model output can
raise one.

## 4. Evidence is produced by the harness

Only qare writes evidence: commands it ran, exit codes it captured, screenshots
it saved, traces it recorded. A claim from a model that is not backed by an
executed check is not evidence, and links are only ever written for files that
were actually uploaded.

## 5. Criteria change only through review

qare proposes criteria; people approve them. A criterion is never weakened,
superseded or retired by the same run that needs it to pass, proposals arrive
as pull requests, and any ledger change that lands with a change is named in
that run's evidence. Editing the requirement is the cheapest way to go green,
so it is the path that stays closed.

## 6. Fail closed

An empty plan, a missing stub, a boot failure, a truncated model response, or a
schema violation stops the run with a named outcome. None of them fall through
to a pass.

## 7. Secrets never share a machine with pull request code

The step that executes pull request code holds no model key and no GitHub
token, and reaches nothing outside the declared stubs. Planning and judging run
in separate steps.
