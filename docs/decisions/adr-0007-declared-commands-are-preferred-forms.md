# ADR-0007: a declared command is a form the planner should prefer, not the only form its program may be planned in

Date: 2026-10-08
Status: provisional, pending the owner's confirmation. Written by the agent
that shipped issue #270, unattended. It records what the code does today and
proposes to keep it; the owner has not accepted it, and has not accepted the
containment gap it describes.

**Read this first.** Under this decision alone, the form a planner picked for
a command decided whether pull request code ran inside the no-network cell or
outside it. That gap was never accepted, and **#286 has closed it** (shipped
in 2026.10.34): the run contains a command check by the program it runs,
whatever its form, so `node -- check.mjs` and `node check.mjs` land in the
same cell. This ADR is only about which forms the plan step accepts, and
rests on #286. What #286 left open is said there and in SPEC ("Containing a
command"): a profile that declares no command that runs contained has no
cell, and its command checks run with the step's network.

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
| 1. Preferred forms (today) | No plan that is accepted today is refused tomorrow. A profile author adds a command to help the planner and loses nothing by it. | A planner may still write a declared program in a form that cannot work, and the run finds out. A form no declaration matches also runs outside the command cell (see "What this costs"). |
| 2. Only forms | A declared program can be planned only as the profile wrote it, so a malformed use is caught at the plan step for every program, not only grep, and every planned use of a declared program is one the run contains. | Declaring a command silently forbids every other use of its program. A profile that declares `node -- {{path}}` can no longer plan `node --version`, `node --check`, or `node --test`; one that declares a `pnpm` test command can no longer plan `pnpm --version`. Existing consumers' profiles would lose plans they get today, with no change on their side, and the criteria behind them would come back unplannable. |

## Decision (provisional)

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
- **It leaves every guarantee in CONSTITUTION.md where it stands today.** The
  model plans and code decides (rule 3) either way: a plan is still only a
  plan, and the verdict still comes from what was executed. Nothing here lets
  a model output raise a verdict. Fail closed (rule 6) is untouched: an
  unknown program, a shell construct, an undeclared path and a missing file
  are still refused at the plan step, and a command that cannot do its job
  still does not pass. Rule 7 is the one the two options differ on, and the
  next section is about it.
- **The evidence does not ask for more.** Every failure that led to #262 was a
  grep. The other malformed command seen (`node` on a TypeScript source, PR 268)
  would not have been caught by option 2 either: it has the declared form's
  shape, and fails for what the file is.
## What this cost before #286: a form outside the declared ones ran outside the cell

(Kept as written before #286 shipped. It is no longer how the code behaves.)

This is the price of option 1, and it is a real one.

A named command is contained (#224): at run time a command check whose run
matches a declared command's whole template runs in a cell with no network
and a read-only copy of the checkout. A check whose run matches no declared
command "runs as it always did, with the network its step has" (SPEC,
"Containing a command"). The match is on the form, not on the program. So
under option 1, a profile that declares `script: node -- {{path}}` gets
`node -- check.mjs` in the cell and `node check.mjs` outside it, and which
of the two is planned is the planner's choice, a model's output written with
the pull request's diff in front of it.

What that is and is not:

- It is not new. It is how #224 shipped and what SPEC already says, for every
  profile today, and it is the same for a standard tool the profile declares
  no command for at all. This decision changes no behaviour, so it opens
  nothing; it declines to close this by the route #270 offered.
- It does not reach a secret. The step that runs a command check holds no
  model key and no GitHub token (CONSTITUTION.md, rule 7), contained or not.
- It does bear on the other half of rule 7, that the step "reaches nothing
  outside the declared stubs". An uncontained command check is pull request
  code with the runner's network. Option 2 would close that for programs a
  profile declares, by refusing the uncontained forms at the plan step. It
  would not close it for a standard tool the profile declares no command for.

So option 2 is the stricter of the two on containment, and option 1 is the
one that breaks no accepted plan. Neither closes the gap whole, and the gap
is not something to leave open: it is a matter of a constitution rule.

#286 is to close it where containment is decided: at run time and by what
the check runs, not by how it is written. Under #286 a check whose program a
declared command contains will run in the cell whatever its arguments or
form. That keeps `node --version` plannable and contains it too, which
refusing forms at the plan step would not. #286 is also to say what becomes
of a standard tool no declared command covers, since "uncontained by default" is the thing rule 7
is about. This ADR proposes option 1 on the footing that #286 ships; without
it, option 2 is the better choice, and "Reversing this" says how to take it.

## Consequences

- Since #286, a planned use of a declared program in a form no declaration
  matches runs in the same cell as the declared form, with no scratch path.
  A profile author who declares one contained command for a program has that
  program contained in every use.
- A profile author cannot use `commands:` to forbid a use of a program. If that
  is wanted, it needs its own profile key that says so in as many words (for
  example a per-command `only: true`), so that declaring a helpful form never
  silently takes other forms away.
- A malformed use of a declared program other than grep is still found by the
  run, not by the plan step. When such a failure shows up in evidence, the fix
  is a rule for that program's own contract, as for grep, not the general rule.

## The change that closed the gap

- Issue #286, shipped in 2026.10.34: a command check is contained by the
  program it runs, whatever its form, so the form a planner picks does not
  decide whether pull request code has the network. The sections above that
  describe the gap describe the code as it was when this ADR was first
  written, and are kept as the record of why #286 was made.

## Reversing this

The decision is one function wide. To take option 2 instead: generalise the
declared-form branch of `grepGap` in `packages/core/src/plan-step.ts` from
`grep` to every program a declared command names, update the test "a standard
tool the profile also declares may be planned in another form" in
`packages/core/test/grep-check.test.ts` to expect the correction, and replace
this ADR. Expect existing plan step tests that plan `node --version` beside a
declared `node` command to change with it.
