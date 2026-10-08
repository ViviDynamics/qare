# The verifier asks in batches, so one cut-off turn does not unverify every proven criterion

Issue #275

## Scope
In: `runVerifier` asks about the proven criteria in batches, one model turn a
batch, and merges the findings. A lost batch leaves only its own criteria
unverified. Usage sums over batches. The size is `QARE_VERIFY_BATCH_SIZE`,
forwarded by the pipeline input `verify-batch-size` into the judge container
when set, and documented. A long suite stream gets a bounded end the verifier
is pointed at.

Out: the advisory UX review, which is one turn about screens and not about
criteria. Running batches at the same time (#265 covers the planner; the
same reasoning applies).

## Assumptions
- The verifier gets its own setting, with the planner's default of 1. What a
  turn costs is different work in each (writing checks, reading evidence),
  so a caller who tuned one has said nothing about the other, and each step
  is handed only its own setting.
- A batch's findings are filtered to the criteria that batch was asked
  about before `consumeVerifierFindings` sees them, and its trusted claims
  are that batch's claims, so a citation only counts for evidence the turn
  was really handed. Its guarantees are unchanged: nothing upgrades, nothing
  is created.
- A budget or a batch size that cannot be read leaves every proven criterion
  unverified by name, as an unreadable budget already did.
- The bound on suite output is a file the run writes, not an instruction to
  the model: `stdout.tail.txt` holds the last 16 KiB of the swept stream in
  whole lines, and the verifier's evidence list names it in place of the
  whole stream. The whole stream stays saved and listed for people. A stream
  inside the bound has no stand-in and is read whole.
- Only proven criteria are verified, and a proven suite passed: the end of
  its output is its summary. Nothing a failed criterion needs is hidden,
  because a failed criterion is not put to the verifier.

## Tasks
- [x] 1. `verifyBatchSize` reads and validates its own setting: core/test/verifier-batches.test.ts
- [x] 2. Claims are asked a batch a turn; findings stay in their batch; usage sums: same file
- [x] 3. A cut-off, an error, a thrown runner and an unreadable answer each cost one batch: same file
- [x] 4. The run writes a bounded end for a long suite stream, and the judge points the verifier at it: core/test/suite-output.test.ts
- [x] 5. The pipeline input `verify-batch-size` reaches the judge container when set, with its docs row: cli/test/pipeline-caller.test.ts
- [x] 6. Release stamped
