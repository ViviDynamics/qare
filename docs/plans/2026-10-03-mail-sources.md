# Mail sources: a sink locally, a real provider on a deployment

Issue #65 (first slice: the adapter interface and the sink side)

## What is already there

- #67 shipped the `mail` check kind, the wait, `message.json`, and the
  `mail.inbox` listing contract (a GET with `address` and `after`).
- #64 and #69 shipped code and link extraction and single-use artefacts.
- #52 shipped redaction; #122 shipped target profiles.
- #66 was closed as not planned. There is no "environment finding" in qare:
  a source that cannot be read, and a message that never arrives, are
  `unverified` with the reason named. This slice keeps that vocabulary.

## Scope

In:

- One adapter interface, `MailSource`: list by address and arrival time,
  read, delete. The `mail.inbox` contract becomes one adapter behind it.
- A sink adapter for Mailpit (`mail.source: { kind: mailpit, url }`), which
  is what the spec's own stub example names.
- `mail.domain`: the domain the per-run address is minted on.
- The wait window opens when the criterion starts, not when the mail check
  starts. A real catcher showed the gap: the check that triggers a message
  runs before the mail check, so a message sent synchronously was always
  received "before the check started" and never matched.
- A run deletes the mail at the addresses it minted when it finishes, and
  records what it deleted in `mail-cleanup.json`.
- The result carries the message that proved a criterion, and the comment
  shows it: sender, subject, an excerpt and its links.
- Mail addresses and one-time codes are swept from the message evidence.
  The body is never stored whole, only the excerpt.
- `examples/mail-app`: a compose stack with an app that sends over SMTP and
  a real Mailpit. CI boots it through the pipeline's own execute steps,
  proves two criteria from real messages, then runs two waits concurrently
  against one catcher and holds them to no crosstalk and a clean inbox.
- Guidance in `docs/pipeline.md` and the spec.

Out, and why:

- Receiving adapters for a real provider (a hosted inbound endpoint with a
  credential, IMAP or a mailbox API). No provider, domain, mailbox or
  credential exists to verify one against, and where such a credential may
  live is a decision rule 7 makes hard: execute runs pull request code and
  holds no secret, and a target run's command checks are still model
  written from the pull request. That needs its own design. Follow-up issue.
- The refusal of a real-provider check from the sandboxed step: it belongs
  with the adapters it refuses. Same follow-up.
- Authentication assertions (SPF, DKIM, DMARC alignment, sending domain,
  placement). A sink adds no `Authentication-Results` header, so nothing
  here could prove one. Follow-up issue.
- Version bump. Nothing a caller's pipeline pins changes.

## Assumptions

- `mail.inbox: <url>` keeps working and means `source: { kind: inbox, url }`.
  A profile names one or the other, not both.
- A source URL may carry `{{run.*}}` values, as the health URL does, so a
  stack can publish its catcher behind the one port a run mints.
- Cleanup touches only addresses the run minted. A literal shared address
  may belong to another run, so it is left alone and the record says so.
- Cleanup never changes a verdict. A source that cannot delete is recorded.
- Mailpit's `to:` search matches substrings, so the adapter filters
  recipients exactly and deletes by message id, never by query.
- The comment section is additive, like the accessibility one (#149).

## Tasks

- [x] 1. `MailSource` and the inbox adapter behind it: `mail-source.test.ts`
      (list, read, delete, and a reader that a mail check waits on).
- [x] 2. The Mailpit adapter: `mail-source.test.ts` against a fake speaking
      Mailpit's recorded response shapes (exact recipient, arrival time,
      text body, delete by id).
- [x] 3. Profile: `mail.source`, `mail.domain`: `profile.test.ts`.
- [x] 4. The run mints on the domain and reads through the declared source:
      `mail.test.ts`.
- [x] 5. The wait window opens with the criterion: `mail.test.ts`.
- [x] 6. Cleanup and `mail-cleanup.json`: `mail.test.ts`.
- [x] 7. Addresses and codes swept from the message evidence: `mail.test.ts`.
- [x] 8. The result carries the message, and the comment shows it:
      `mail.test.ts`, `evidence.test.ts`, `result.test.ts`.
- [x] 9. Two concurrent runs on one source read only their own mail:
      `mail.test.ts`.
- [x] 10. `examples/mail-app` loads and the CI step is the pipeline's own:
      `examples/test/mail-app.test.mjs`; a real boot in the `compose-boot`
      job with `scripts/mail-sink.sh`.
- [x] 11. The planner is told where a mail check waits and what comes before
      it: `plan-step.test.ts`.
- [x] 12. Spec, schemas and guidance.

## What the real catcher showed

- A message sent synchronously arrives before the mail check starts (the
  example's wait was 20ms, one poll). With the window at the check's start it
  was never read. Task 5 came from this.
- The link a later check follows is swept as a secret wherever it appears
  (#64), so the example's evidence shows `[redacted]` where the confirmation
  link was, and an empty `links`. The other links of a message are shown.
  Whether a link that is not single-use should be shown is left to a person.
