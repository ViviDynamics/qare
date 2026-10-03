# Advisory UX review: findings a person reads, never a verdict

Issue #150

## The gap

A change can meet every stated criterion and still leave a confusing flow, a
label that does not match the ones around it, or an error message that helps
nobody. No criterion states those, so no check finds them. A model can spot
them, and rule 3 says a model decides nothing: so the review is advisory. Its
findings are shown to a person and are never part of a verdict.

## Scope

In:
- A UX reviewer in `qare judge`, after the verdict is computed. It runs
  through nare with the read-only tool set, its file root the evidence
  directory, exactly as the verifier does, in the step that already holds the
  model key (rule 7: no new holder of the key, and execute still holds
  nothing).
- What it reads: for each screen the run's flows visited, the text evidence
  the harness saved (the action log, the accessibility snapshots, the
  accessibility audit record), with the criterion's text, `QA.md` and the
  profile's house rules as context.
- What it reports: findings, each with the screen, what it saw, why it
  matters and a severity. Code attaches the screenshot the harness saved of
  that screen (rule 4); the model never names a file.
- Where they go: `advisory` in `judged-result.json`, a key of its own that
  nothing in the judge reads, and an "Advisory UX review" section of the
  comment, marked advisory. The check run says nothing about them.
- The profile's `ux` section: `review: false` turns it off, `rules` are the
  house rules.
- Dismissal: a reply `/qa-dismiss <id>` on the pull request. qare records it
  in a comment of its own, and a dismissed finding is not raised again on
  that pull request: the reviewer is told what was dismissed, and code drops
  a finding whose identity matches.
- Promotion: a reply `/qa-promote <id>`. qare files one issue carrying the
  finding, its screen, its screenshot and a link back to the pull request,
  and records it so the same finding is not filed twice. Nothing else files
  one.
- The pipeline: a step in judge, before the model step, that carries out the
  replies and hands the dismissed list on, and an `advisory` job a caller's
  `issue_comment` trigger starts so a reply is acted on at once. Both hold
  the GitHub identity only.
- SPEC, schemas, pipeline guide.

Out:
- Looking at the screenshots. nare's `read` tool returns UTF-8 text, so the
  reviewer reads the snapshots and logs and cannot see pixels. That is a gap
  in nare, asked for as ViviDynamics/nare#48 (rule 2); the seam here is the
  list of files a screen hands the reviewer.
- Any effect on the verdict, the check run, the exit code or the cache.
- `qare check` and the MCP adapter: the review runs where the pipeline
  judges. They can call `reviewUx` later.
- Promotion by label. A label names no finding; a reply does.
- Dismissals that outlive the pull request (a repository-wide list). The
  profile's house rules are where a standing "we do it this way" belongs.
- The verdict path of vision (#86).
- The metrics record. The review's token spend rides `advisory.usage`.

## Assumptions

- On by default, and silent when there is nothing to look at: a run with no
  screen makes no model call and writes no `advisory` key, so results and
  comments of runs without browser evidence are byte for byte what they were.
- A screen is one check's evidence directory (`checks/<criterion>/<index>`)
  that holds an action log, a snapshot or an audit record. The run checks the
  criteria of the change, so the screens its flows visited are the screens
  the change touched. Base-side evidence is not reviewed.
- A refused run, `--runner none` and a profile with `review: false` make no
  review. Several apps: an app whose profile turns it off has its screens
  left out, and each app's rules are named for it.
- The reviewer fails open for the verdict and closed for itself: a runner
  that throws, a run that does not complete or an answer that is not a
  findings list yields `status: "unavailable"` with the reason, no findings,
  and the same verdict and exit code. The comment says the review did not
  answer.
- Model output is filtered in code: a finding naming a screen it was not
  given is dropped, text is capped and redacted with the run's rules, and at
  most 20 findings are kept. No field of a finding names a criterion outcome.
- A finding's identity is a hash of its screen, its category (a fixed list)
  and the element it names (or what it saw, when it names none). The id is
  what a person types, and what "the same finding on the same screen" means
  in code. A model that rewords a dismissed finding is caught by the list it
  was handed, not by the hash: that half is the model's, and it is advisory.
- Who may dismiss or promote: a commenter GitHub reports as OWNER, MEMBER or
  COLLABORATOR. Anyone else's reply is left alone.
- The finding a reply names is read from qare's own sticky comment (found by
  its author, as the evidence comment is), which carries the findings as
  data. A finding that is no longer in the comment cannot be dismissed or
  promoted, and qare says so in a reply.
- The new pipeline steps run the pinned qare. One that predates the command
  answers "unknown command", so the judge step treats a failure as "no
  dismissals" and says so, never as a failed run: advisory work gates nothing.
- `qare replay` compares the stored verdict without its `advisory` key: the
  recompute calls no model, and the review is not part of the verdict.
- The minimal caller in the guide and the one `qare init` writes stay as they
  are. The `issue_comment` trigger is optional: without it a reply is acted
  on by the next run of the pipeline on that pull request.

## Tasks

- [ ] 1. Profile `ux` section: `packages/core/test/profile.test.ts`.
- [ ] 2. Screens of a run, finding identity, and the filter over the model's answer: `packages/core/test/advisory.test.ts`.
- [ ] 3. The reviewer through the runner seam, failing without touching the result: `packages/core/test/advisory.test.ts`.
- [ ] 4. `advisory` in the result, redacted, and never read by the judge or by replay: `packages/core/test/result.test.ts`, `judge.test.ts`, `redact.test.ts`, `replay.test.ts`.
- [ ] 5. The comment's advisory section: `packages/core/test/evidence.test.ts`.
- [ ] 6. `qare judge` reviews after it judges: `packages/cli/test/judge-advisory.test.ts`.
- [ ] 7. Replies: dismiss, promote, who may, once only: `packages/action/test/advisory.test.ts`, `post-evidence.test.ts`.
- [ ] 8. The pipeline carries out replies and hands the dismissed list to judge: `packages/cli/test/workflow.test.ts`, `pipeline-caller.test.ts`.
- [ ] 9. SPEC, schemas, pipeline guide.
