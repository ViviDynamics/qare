# A run with one worker still runs two criteria at once when one of them has a mail check

Issue #278

## Scope
In: with one worker a run executes one criterion at a time in plan order.
With more, a sequential criterion on the shared app never runs beside a
shared criterion. docs/SPEC.md says exactly what may overlap.

Out: a setting that lets a caller ask for more overlap. Nobody has asked,
and the default that produced false `failed` verdicts is the thing to fix.

## Assumptions
- One worker means plan order across both lanes, interleaved by index, which
  is what a run did before sharding existed.
- With more workers the shared criteria overlap each other: that is what the
  caller asked for, and a profile whose criteria cannot share the app
  declares them isolated.
- A sequential criterion with an app of its own keeps running beside the
  workers, as it did: nothing it touches is theirs. This is unchanged.
- A sequential criterion on the shared app waits for the workers to drain.
  Running it after them does not change what it reads: a mail check reads
  only messages that arrive after its criterion started, and shared criteria
  neither publish nor consume mail artefacts by definition of the lanes.
- Sequential criteria keep plan order between themselves, so mail hand-offs
  are as they were.

## Tasks
- [x] 1. A one-worker run has no two criteria in flight, across lanes, in plan order: core/test/lane-overlap.test.ts
- [x] 2. With two workers a mail criterion never overlaps a shared one, and sequential criteria stay one at a time: same file
- [x] 3. docs/SPEC.md states what may overlap; release stamped
