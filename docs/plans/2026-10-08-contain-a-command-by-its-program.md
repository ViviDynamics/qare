# A command check's containment follows its program, not the form the planner picked

Issue #286

## The gap

A named command is contained (#224), but the run decided that by matching
the check's whole run against a declared command's template. `node --
check.mjs` matched `script: node -- {{path}}` and ran in the cell;
`node check.mjs` matched nothing and ran with the network its step has. The
plan is a model's output, written with the pull request's diff in front of
it, so the form it picked decided whether pull request code had the runner's
network. That bears on constitution rule 7: the step that executes pull
request code "reaches nothing outside the declared stubs".

## Scope

In:
- `containmentOf` in `packages/core/src/run.ts`: where a command check runs
  is decided from its program (the first word of the command, by name,
  whatever path it is written with):
  - a check that fills a declared command is held to that declaration, its
    scratch paths or its opt-out;
  - any other check of a program the profile declares runs in the cell, with
    no scratch path, unless every declaration of that program opts out;
  - a program the profile declares nothing for runs in the cell whenever the
    run has one;
  - only a run with no cell leaves a command check uncontained.
- Every command check writes `outbound.json`. One that ran outside a cell
  says so and why.
- The cache marker moves to `command-egress-cell-v2` and is on every
  profile's fingerprint, so no result proven under the form rule is replayed.
- The planner is told that every command check runs in the cell when the
  profile contains a command.
- SPEC, and ADR-0007, which described the gap.

Out, and said in as many words in SPEC and the pull request:
- A run with no cell. A profile that declares no command that runs contained
  has none, and its command checks (standard tools) run with the step's
  network, as before #224. Closing that means every command check needs a
  docker daemon, a Linux host and the image, on every host qare runs on,
  including a one-off `qare check` on a laptop. That changes what qare
  requires of a host; it is the owner's call and its own issue.
- Suites, which are uncontained by the decision recorded in #224 (a suite may
  need the docker daemon, which a cell withholds).

## Assumptions

- The program is the first word of the run by name: `/usr/bin/node` is
  `node`. A wrapper (`env node ...`) is another program; the plan step
  already refuses a program that is neither declared nor a standard tool.
- "Never less contained than the most contained declaration of its program":
  a form no declaration matches takes the cell if any declaration of the
  program is contained, and takes no scratch path, since scratch is declared
  for a form.
- An opt-out is the profile's word for the form it is written on. Beside a
  contained declaration of the same program it covers that form alone.
- A check that used to run uncontained and now runs in the cell can newly
  fail to write a file or to reach an undeclared host. That is the change
  working: it is refused by name (`refused: undeclared host: ...`), or fails
  against the read-only copy with the tool's own message.

## Tasks

- [x] 1. The same program in several spellings (declared form, another form,
  bare, by path) asks for the same cell and records `"containment": "cell"`:
  `packages/core/test/command-run.test.ts`.
- [x] 2. Another form is refused the same destinations; it gets no scratch;
  a program with one contained and one opted-out declaration; a program
  whose declarations all opt out; an undeclared program on a run with a
  cell; a run with no cell records why: same file.
- [x] 3. The cache marker: `packages/core/test/cache.test.ts`,
  `packages/core/test/client-run.test.ts`.
- [x] 4. The planner's prompt: `packages/core/test/grep-check.test.ts`.
- [x] 5. SPEC, ADR-0007, and the release stamp.
- [x] 6. Found by the live run: a `--version` or `-v` among the arguments of
  a command a cell launches was read as qare's own, so the check printed the
  harness's version and passed without running. What follows `--` is not
  qare's to read: `packages/cli/test/cli.test.ts`.
