# ADR-0007: a declared command is a form the planner should prefer, not the only form its program may be planned in

Date: 2026-10-08
Status: accepted (decided by the agent that shipped issue #270, on the owner's
behalf; reversible, see "Reversing this")

## Context

A profile may declare named commands (`commands:` in `config.yml`, #156), each
a `run` line with `{{placeholders}}` the planner fills. The plan step also
accepts a command check whose program is a standard tool the runner carries,
whether or not the profile declares a command for that program.

Issue #262 asked that "a command check that uses a standard tool the profile
also declares as a command is held to that command's shape". PR 269 delivered
that for `grep` alone: every failure in evidence was a grep whose pattern was
several words, and the general rule changes which plans are accepted. Issue
#270 asks for the decision the general rule needs: is a profile's `commands`
section

1. a list of forms known to work, which the planner should prefer, or
2. the only forms a declared program may be run in?

qare's own profile reads like the second ("the commands a command check can
genuinely run in the published image"). The plan step's allowlist of standard
tools, and its tests, read like the first: a profile that declares
`script: node -- {{path}}` may still plan `node --version`.

## Options

| Option | What it gives | What it costs |
| --- | --- | --- |
| 1. Preferred forms (today) | No plan that is accepted today is refused tomorrow. A profile author adds a command to help the planner and loses nothing by it. | A planner may still write a declared program in a form that cannot work, and the run finds out. |
| 2. Only forms | A declared program can be planned only as the profile wrote it, so a malformed use is caught at the plan step for every program, not only grep. | Declaring a command silently forbids every other use of its program. A profile that declares `node -- {{path}}` can no longer plan `node --version`, `node --check`, or `node --test`; one that declares a `pnpm` test command can no longer plan `pnpm --version`. Existing consumers' profiles would lose plans they get today, with no change on their side, and the criteria behind them would come back unplannable. |

## Decision

Option 1. **A declared command is a form the planner should prefer. A standard
tool the profile also declares as a command may be planned in any other form
the plan step otherwise accepts.**

`grep` stays the one exception, and for a reason that is grep's own, not a
first step towards option 2: a command check is split on whitespace with no
shell, grep reads every word after its pattern as a file, and it exits 2
without having looked. That failure is common, has one cause, and is
indistinguishable from a real answer unless it is caught, so where the profile
declares a grep command a planned grep is held to that command's form (#262).
No other program is held to a declared form.

Issue #262's second criterion is therefore delivered for grep only, by design.

## Why this one

- **It is the conservative choice.** It refuses no plan that is accepted today,
  so no consumer's run changes. Option 2 would turn working checks into
  unplannable criteria in profiles qare cannot see.
- **It keeps every guarantee in CONSTITUTION.md, and so does the other.** The
  model plans and code decides (rule 3) either way: a plan is still only a
  plan, and the verdict still comes from what was executed. Nothing here lets
  a model output raise a verdict. Fail closed (rule 6) is untouched: an
  unknown program, a shell construct, an undeclared path and a missing file
  are still refused at the plan step, and a command that cannot do its job
  still does not pass.
- **The evidence does not ask for more.** Every failure that led to #262 was a
  grep. The other malformed command seen (`node` on a TypeScript source, PR 268)
  would not have been caught by option 2 either: it has the declared form's
  shape, and fails for what the file is.
- **Containment is not at stake.** What a command check can reach is set by the
  command cell and the declared run inputs (#224, #162), not by the list of
  forms. Option 2 would narrow what the planner may write, not what a command
  can touch.

## Consequences

- A profile author cannot use `commands:` to forbid a use of a program. If that
  is wanted, it needs its own profile key that says so in as many words (for
  example a per-command `only: true`), so that declaring a helpful form never
  silently takes other forms away.
- A malformed use of a declared program other than grep is still found by the
  run, not by the plan step. When such a failure shows up in evidence, the fix
  is a rule for that program's own contract, as for grep, not the general rule.

## Reversing this

The decision is one function wide. To take option 2 instead: generalise the
declared-form branch of `grepGap` in `packages/core/src/plan-step.ts` from
`grep` to every program a declared command names, update the test "a standard
tool the profile also declares may be planned in another form" in
`packages/core/test/grep-check.test.ts` to expect the correction, and replace
this ADR. Expect existing plan step tests that plan `node --version` beside a
declared `node` command to change with it.
