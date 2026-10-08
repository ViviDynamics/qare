# Mail checks: assert on authentication results, sending domain and placement

Issue #218

## Scope

In:
- `MailMessage` carries `headers` and `placement` where a source can report
  them. The Mailpit adapter reads headers from the catcher; the inbox contract
  may list both with a message.
- `packages/core/src/mail-auth.ts`: an `Authentication-Results` parser (RFC
  8601) and `assessDelivery`, which holds a message to what a check asserts.
- `mail.source.authserv` in the profile: the receiving provider a source
  reads, by the id it writes its results under. Results count only under it.
- `authentication` (`require`, `domain`) and `placement` on the `mail` check, in the plan and the job, parsed by one function
  (`packages/core/src/mail-delivery.ts`), carried through `jobFromPlan`, the
  plan lock, the planner's output schema and its prompt.
- The run writes what was read into `message.json` and one line into the
  criterion's mail proof, which the comment shows beside the message.
- SPEC and the schema reference.

Out:
- Verifying signatures or querying DNS from qare, and reputation scoring (the
  issue's own exclusions).
- Showing it against a real receiving provider. That needs an account (#65,
  #217). Everything here is shown with crafted headers, as the issue says a
  catcher allows.
- A placement reading for Mailpit: a catcher has no folders.

## Decisions made without the owner, each reversible

- **A failing authentication result is `unverified`, naming the record.** The
  issue leaves this to a person: either that, or environment findings come
  back as an outcome of their own (#66, closed as not planned). `unverified`
  with the reason named is the vocabulary there is, it meets "the criterion is
  not `failed`", and it adds no outcome a consumer would have to learn. If
  environment findings return, `assessDelivery` is the one place that would
  say so.
- The same goes for a sending domain or a placement that is not the one
  expected: unverified, never failed. A message from the wrong domain could
  be the product's doing; without a way to tell, it is not reported as one.
- A header proves nothing by itself: the sender can write it, and the app
  under test is the sender. The first draft read the topmost header and let a
  plan name the server, which let a message vouch for itself against a
  catcher (found in review). Results now count only under the id of a
  receiver the profile declares, a catcher cannot be declared one, and a plan
  cannot name it.
- Alignment is read without the public suffix list: same domain, or one a
  subdomain of the other. The receiver's `dmarc=` result is what counts.
- A message whose delivery is not as asserted publishes no artefact (link,
  code) to later checks.

## Tasks

- [x] 1. The parser and `assessDelivery`: `packages/core/test/mail-auth.test.ts`.
- [x] 2. Headers and placement from the sources:
  `packages/core/test/mail-source.test.ts`.
- [x] 3. The check's fields in the plan and the job, and their refusals:
  `packages/core/test/mail.test.ts`.
- [x] 4. The three "Done when" items through a run, and the comment:
  `packages/core/test/mail.test.ts`, `packages/core/test/evidence.test.ts`.
- [x] 5. SPEC, schemas, and the release stamp.
