# A suite that fails leaves no output behind, so the failure cannot be read

Issue #272

## Scope
In: a suite check saves `stdout.txt` and `stderr.txt` beside `suite.txt`,
swept and bounded with the end kept, lists them as evidence, and a failed
suite's reason carries the last lines of its output. docs/SPEC.md lists the
files.

Out: command checks, which keep the start of an output past the limit as
they did. Putting suite output in the job log.

## Assumptions
- The bound is the command check's: 1 MiB a stream. A suite keeps the end,
  because a test run reports its failures last.
- When the start is dropped, the partial first line goes with it: half a
  line helps no reader, and half a secret is one the sweep cannot recognise.
- The reason takes the last six lines of stdout and the last three of
  stderr, each cut at 200 characters, joined on one line (the comment's
  reason is one table cell), without terminal colour codes. The files keep
  the output as the suite wrote it.
- Output is saved for every outcome: a passing suite's output is what the
  verifier reads, and a suite that timed out is explained by what it printed.
- The verifier is handed whatever the criterion lists as evidence, so
  listing the files is what gives them to it.

## Tasks
- [x] 1. The suite's streams are captured with the end kept and handed back: core/test/suite-output.test.ts
- [x] 2. They are saved swept and bounded, and listed as evidence: same file
- [x] 3. A failed suite's reason carries the bounded tail: same file
- [x] 4. docs/SPEC.md lists the files; release stamped
