# ADR-0008: a command check may run uncontained when the profile declares no contained command, and its evidence says so

Date: 2026-10-09
Status: accepted. Decided by the owner on 2026-10-09 (issue #287). It records
what the code has done since #286 and changes no behaviour.

## Context

Since #286 a command check is contained by the program it runs, whatever its
form, and on a run that has a command cell a command check runs in it unless
the profile opts its program out in as many words (`egress: uncontained` on
the declared form, or on every declaration of the program). A
run has a cell only when its profile declares at least one command that runs
contained (`commandCellContextOf` in `packages/core/src/run.ts`).

On a run without one, a command check (a standard tool: `node`, `python3`,
`grep`, `test`, `nare`) runs with the network its step has, as it did before
#224. Its evidence records that: `outbound.json` carries
`"containment": "none"` and the reason.

That is pull request code with the runner's network. CONSTITUTION.md rule 7
has two halves. The first, that the step that executes pull request code
holds no model key and no GitHub token, holds for every profile, contained or
not. The second, that the step "reaches nothing outside the declared stubs",
is the one a command check does not meet for such a profile. #286 left the
question open and #287 asked for the decision: may a command check ever run
outside a cell without the profile saying so in as many words?

## Options

| Option | What it gives | What it costs |
| --- | --- | --- |
| 1. It may, and the evidence says so (today) | Every host that runs qare today keeps running it: a one-off `qare check` on a laptop, a native run, a target on the machine's own loopback. | For a profile that declares no contained command, command checks do not meet the second half of rule 7. A reader has to look at the evidence to know. |
| 2. It may not | Every command check the profile has not opted out is in a cell or is refused by name, so the second half of rule 7 holds for command checks in every profile. | A cell needs a docker daemon, a Linux host and the image. A host without all three would have every command check refused. A target on the machine's own loopback cannot be reached from a cell at all. The harness's own suite runs several hundred command checks natively, and each would need a cell or a stand-in. Suites are uncontained by the decision recorded in #224, so command checks alone would still not make rule 7 hold. |

## Decision

Option 1. **When a profile declares no contained command, its command checks
may run with the step's network, and the evidence records that they ran
uncontained.**

- Nothing changes in the code. This is the behaviour #286 shipped in
  2026.10.34.
- Declaring one contained command is the way a profile gets a cell for its
  command checks (all of them but the programs it opts out). No other profile
  key gives one, and this decision adds none.
- Suites stay as #224 recorded them: uncontained, because a suite may need
  the docker daemon a cell withholds, with evidence that says so in as many
  words. This decision does not revisit that.

## What this accepts, and what it does not

- **Accepted:** for a profile that declares no contained command, a command
  check is pull request code that can reach whatever the runner can. That is
  a known, recorded exception to the second half of rule 7, taken so that
  qare does not start requiring a docker daemon, a Linux host and the image
  of every host.
- **Not accepted, and still closed:** a secret on that machine. The step
  holds no model key and no GitHub token (rule 7, first half), and nothing
  here changes which job holds which secret.
- **Not accepted, and still closed:** an uncontained check that reads as
  contained. Only the harness writes evidence (rule 4), and it writes
  `"containment": "none"` with the reason for every such check. A reader of
  a run can always tell which checks had the network.
- **Not accepted, and still closed:** the form of a check as a way out of a
  cell. On a run that has a cell, a check of a form no declaration matches
  runs in it, and only the profile's own `egress: uncontained` takes a check
  out (#286, [ADR-0007](./adr-0007-declared-commands-are-preferred-forms.md)).

CONSTITUTION.md is not edited by this decision. Rule 7 still states the rule
without the exception, so the two read differently until the owner says
whether the constitution's own text should carry it; until then this ADR is
the record that the gap is known and accepted, and by whom.

## Consequences

- A profile author who wants command checks contained declares one contained
  command. A profile author who does nothing gets command checks that work on
  any host and are recorded as uncontained.
- Where a run says a command check ran uncontained is its evidence
  (`outbound.json`). `qare doctor` and the readiness report do not say it
  ahead of a run. #287 asked for that if this option was taken; the owner's
  decision was to change no behaviour, so it is not delivered here and is
  tracked as #292.
- The operator of a runner that executes such a profile should assume its
  command checks have the runner's network, and place the runner accordingly.

## Reversing this

To take option 2: make `commandCellContextOf` in `packages/core/src/run.ts`
give every run a cell, refuse a command check by name with the reason where a
host cannot make one, add the profile's explicit opt-out, say in the docs
what a host must have, and replace this ADR. Expect the harness's native
command check tests to need a cell or a stand-in.

## References

- Issue #287 (the question), #286 (containment by program), #224 (the cell,
  and suites left uncontained).
- [docs/SPEC.md](../SPEC.md), "Containing a command".
- CONSTITUTION.md, rules 4 and 7.
