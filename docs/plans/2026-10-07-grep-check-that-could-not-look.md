# A grep check with a pattern of several words fails a criterion nothing disproved

Issue #262

## Scope
In: the plan step corrects, then refuses, a planned `grep` whose pattern is
several words; a `grep` check that exits 2 or more leaves its criterion
unverified with grep's own message; the planner is told a pattern is one
token and that a check runs the checkout unbuilt.

Out: holding every standard tool to its declared command's form, which the
issue's second criterion states for any tool. It is done for grep only: a
profile that declares `node -- {{path}}` still plans `node --version`, as
existing tests require, and the evidence is all about grep. A runtime rule
for an interpreter that fails to load its script: there is no safe one (see
Assumptions).

## Assumptions
- `failed` must mean disproven, and `unverified` must never hide a real
  failure. grep's contract draws the line itself: 1 is "no match", 2 or more
  is "could not read". A missing file that the change should have added also
  exits 2, and is now unverified rather than failed; it still blocks the
  run, and the reason carries grep's own words, so it is not hidden.
- `node file` exiting 1 with ERR_MODULE_NOT_FOUND cannot be told from a real
  failing check: a script that imports what the change was meant to add
  fails identically when the change did not add it. No runtime rule; the
  planner is told not to run a TypeScript source or anything needing a build.
- The plan step reads the base revision, so a file the change adds is not in
  its checkout. The declared run inputs name the paths the diff touches, and
  a path among them counts as there, for the new grep rule and for the
  existing placeholder rule (#201), which had the same blind spot.
- The grep rule runs after the run-contract rules, so a run output or an
  undeclared input is named for what it is first.

## Tasks
- [x] 1. A several-word grep is corrected naming the argument, then refused: core/test/grep-check.test.ts
- [x] 2. A declared grep command's form is what a planned grep must have: same file
- [x] 3. A file the change adds is not a missing file: same file
- [x] 4. grep exit 2 or more is unverified with its message; exit 1 still fails; other programs unchanged: same file
- [x] 5. The prompt says so; docs/SPEC.md documents it; release 2026.10.23 stamped
