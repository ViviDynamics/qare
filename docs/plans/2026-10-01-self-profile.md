# qare's own profile declares commands and out-of-reach statements (#158)

## Goal

qare's self-run is a fair test of qare: the profile says what its criteria are
usually about, declares commands that genuinely work in the run image, and says
plainly what is out of reach so the planner marks those unplannable with a
specific reason instead of guessing an invocation that proves nothing.

## Reality the profile must match

Probing the published qare-web 2026.10.1 image: it has node 22, grep, test,
python3, nare and its own compiled qare CLI. It has no npm, no git, no jq, no
pnpm and no vitest, and the executing job installs and builds nothing. So:

- A vitest suite (package behaviour, CLI behaviour, the workflow structural
  tests) cannot run in a self-run. Declaring vitest or pnpm commands would plan
  checks that cannot start.
- A command check can genuinely show structure on the paths the change
  touches: source assertions with grep, and plain-JavaScript check scripts run
  with node.

## Changes

1. `.qa/config.yml` declares two commands, both verified in the run image:
   - `source`: `grep -n {{pattern}} {{path}}` - a structural source assertion.
   - `script`: `node {{path}}` - runs a plain-JavaScript check script the
     change adds; the exit code is the verdict.
2. `.qa/QA.md` gains the sections a planner needs: what qare is, what its
   criteria are usually about, what a self-run can and cannot show, with the
   specific missing thing named for every out-of-reach kind (no test runner,
   nothing installs or builds, no model in the executing job, one runner with
   its own clock).
3. A structural test loads the repository's own profile through the real
   loader and pins both properties: every declared command's program is a
   program the run image really has, and the instructions say plainly that
   test-suite criteria are out of reach.

## Evidence

- Local: the structural test (red before, green after); each declared command
  executed in the published image against this checkout with a real pattern,
  showing non-empty proper selections.
- Deferred: re-planning the four closed issues' criteria (#138, #141, #144,
  #153) needs the planner model key, which exists only as the pipeline's
  QARE_PLANNER secret; the next three pull requests' self-runs carry the
  verdict evidence, which is the second done-when's design.
- Cross-check finding: the planner prompt's standard-tools list names npm, git
  and jq, which the published image does not carry. Filed separately; not
  touched here.

## Not here

- Making the vitest suites runnable in a self-run needs the runner image to
  carry a test runner and the workspace's dependencies, and the run-inputs
  contract to accept them - a #162-scale change with its own issue.
- The command report-format field belongs to #157, which stays open.
