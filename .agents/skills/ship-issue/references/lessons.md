# Lessons (when `VIVI_LESSONS=on`)

Read by ship-issue in Stage 1 and after Stage 6 when lessons are on.


Each run learns something the next run should not have to rediscover. With lessons on:

- **Stage 1 reads** `VIVI_LESSONS_FILE` (default `.agents/lessons.md`) alongside the
  house rules.
- **Record as it happens**, always with a link to the evidence:
  - a verified retry that turned a job green:
    `$S/lessons observe <issue> flake_retry --log-file <saved job log> --log-line "<exact line>" --evidence <run url>`
    (refused unless the line appears verbatim in the log);
  - a real CI failure: `$S/lessons observe <issue> real_failure --area <area> [--preflight-row-missing] --evidence <run url> --text "<root cause>"`;
  - a repo fact that cost more than one cycle to find:
    `$S/lessons observe <issue> repo_fact --text "<one line>" --evidence <url>`.
- **Propose, never apply silently.** After Stage 6, run `$S/lessons propose`. When it
  has candidates, open one small separate PR: `$S/lessons propose --write` appends the
  flake lines and lessons; add any proposed test-command rows by hand with the right
  command. List every line with its evidence in the PR body. The flake file is a
  protected path, so the PR needs a `### Quality gate changes` section; that review is
  the point. Work it in its own worktree from a fresh default branch, and remove that
  worktree (`git worktree remove <path>`) as soon as the PR is pushed: the branch and the
  PR hold everything. After the PR merges, `$S/cleanup --pr <pr>` deletes its branches.

Copy the run's observations into SHIP_RESULT `observations`.
