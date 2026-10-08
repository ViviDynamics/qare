import { expect, test } from 'vitest'
import { assessDelivery, parseAuthenticationResults, type MailMessage } from '../src/index.js'

// #218: a mail check can assert how a message was delivered, not only that
// it arrived. The receiving provider's verdict is the evidence: qare reads
// the Authentication-Results header (RFC 8601), and verifies no signature
// and asks no DNS itself.

const PASSING = 'mx.receiver.example; spf=pass smtp.mailfrom=bounce.sender.example; dkim=pass header.d=sender.example header.s=s1; dmarc=pass header.from=sender.example'

function message(fields: Partial<MailMessage> = {}): MailMessage {
  return {
    from: 'App <no-reply@sender.example>',
    subject: 'Confirm your account',
    body: 'hello',
    received_at: '2026-10-08T10:00:00.000Z',
    headers: { 'authentication-results': [PASSING] },
    ...fields,
  }
}

/** A source the profile declares to be a receiving provider, by the id its results are written under. */
const SOURCE = { describe: 'inbox at the provider', authserv: 'mx.receiver.example' }
/** A catcher: it receives mail and judges nothing, so the profile declares no receiver for it. */
const CATCHER = { describe: 'mailpit at the catcher' }

test('an Authentication-Results header is read into the server that judged, each result and the domain it was evaluated for', () => {
  expect(parseAuthenticationResults(PASSING)).toEqual({
    authserv: 'mx.receiver.example',
    results: [
      { method: 'spf', result: 'pass', domain: 'bounce.sender.example', property: 'smtp.mailfrom', properties: { 'smtp.mailfrom': 'bounce.sender.example' } },
      { method: 'dkim', result: 'pass', domain: 'sender.example', property: 'header.d', selector: 's1', properties: { 'header.d': 'sender.example', 'header.s': 's1' } },
      { method: 'dmarc', result: 'pass', domain: 'sender.example', property: 'header.from', properties: { 'header.from': 'sender.example' } },
    ],
  })
})

test('comments, folding, a version, a reason, quoted values and a mailbox for the envelope sender are read as RFC 8601 writes them', () => {
  const folded = [
    'mx.receiver.example 1;',
    '\tspf=fail (sender IP is 203.0.113.9; see the record) smtp.mailfrom=bounce@Sender.Example;',
    '\tdkim=fail reason="signature did not verify" header.d="sender.example" header.i=@mail.sender.example header.s=s1;',
    '  dkim/1=pass (2048-bit key (rsa)) header.d=relay.example;',
    '\tdmarc=fail (p=reject) header.from=sender.example',
  ].join('\r\n')
  const parsed = parseAuthenticationResults(folded)
  expect(parsed?.authserv).toBe('mx.receiver.example')
  expect(parsed?.results.map((result) => [result.method, result.result, result.domain])).toEqual([
    ['spf', 'fail', 'sender.example'],
    ['dkim', 'fail', 'sender.example'],
    ['dkim', 'pass', 'relay.example'],
    ['dmarc', 'fail', 'sender.example'],
  ])
  expect(parsed?.results[1]?.reason).toBe('signature did not verify')
  expect(parsed?.results[1]?.selector).toBe('s1')
})

test('a header that reports nothing, or that is not one, is no result at all', () => {
  expect(parseAuthenticationResults('mx.receiver.example; none')).toEqual({ authserv: 'mx.receiver.example', results: [] })
  expect(parseAuthenticationResults('')).toBeUndefined()
  expect(parseAuthenticationResults('; spf=pass')).toBeUndefined()
  // What is not method=result is not guessed at.
  expect(parseAuthenticationResults('mx.receiver.example; spf pass; dkim=pass header.d=sender.example')?.results.map((result) => result.method)).toEqual(['dkim'])
})

test('a message that passes all three is passed, with the results and the alignment in the evidence', () => {
  const outcome = assessDelivery(message(), { authentication: { require: ['spf', 'dkim', 'dmarc'], domain: 'sender.example' } }, SOURCE)
  expect(outcome.status).toBe('passed')
  expect(outcome.evidence).toEqual({
    authentication: {
      authserv: 'mx.receiver.example',
      from_domain: 'sender.example',
      results: [
        { method: 'spf', result: 'pass', domain: 'bounce.sender.example', aligned: true },
        { method: 'dkim', result: 'pass', domain: 'sender.example', selector: 's1', aligned: true },
        { method: 'dmarc', result: 'pass', domain: 'sender.example', aligned: true },
      ],
    },
  })
  expect(outcome.summary).toBe('spf=pass (bounce.sender.example), dkim=pass (sender.example), dmarc=pass (sender.example), judged by mx.receiver.example')
})

test.each([
  ['spf', 'mx.receiver.example; spf=softfail smtp.mailfrom=bounce.sender.example; dkim=pass header.d=sender.example; dmarc=pass header.from=sender.example', /spf=softfail for smtp\.mailfrom=bounce\.sender\.example.*the SPF record of bounce\.sender\.example/],
  ['dkim', 'mx.receiver.example; spf=pass smtp.mailfrom=sender.example; dkim=fail header.d=sender.example header.s=s1; dmarc=pass header.from=sender.example', /dkim=fail for header\.d=sender\.example.*the DKIM key s1\._domainkey\.sender\.example/],
  ['dmarc', 'mx.receiver.example; spf=pass smtp.mailfrom=sender.example; dkim=pass header.d=sender.example; dmarc=fail header.from=sender.example', /dmarc=fail for header\.from=sender\.example.*the DMARC record _dmarc\.sender\.example/],
])('a message that fails %s is unverified, never failed, naming the record at fault and whose verdict it is', (_mechanism, header, reason) => {
  const outcome = assessDelivery(message({ headers: { 'authentication-results': [header] } }), { authentication: { require: ['spf', 'dkim', 'dmarc'] } }, SOURCE)
  expect(outcome.status).toBe('unverified')
  expect(outcome.reason).toMatch(reason)
  expect(outcome.reason).toContain("mx.receiver.example's verdict")
  // The results are evidence either way.
  expect(outcome.evidence?.authentication?.results).toHaveLength(3)
})

test('only the mechanisms the check requires are held to pass, and a required one the provider did not report is named', () => {
  const header = 'mx.receiver.example; spf=fail smtp.mailfrom=sender.example; dkim=pass header.d=sender.example'
  const held = message({ headers: { 'authentication-results': [header] } })
  expect(assessDelivery(held, { authentication: { require: ['dkim'] } }, SOURCE).status).toBe('passed')
  const missing = assessDelivery(held, { authentication: { require: ['dkim', 'dmarc'] } }, SOURCE)
  expect(missing.status).toBe('unverified')
  expect(missing.reason).toContain('reports no dmarc result')
})

test('one passing DKIM signature is enough, and with a sending domain expected it must be one that aligns with it', () => {
  const header = 'mx.receiver.example; dkim=fail header.d=sender.example header.s=old; dkim=pass header.d=relay.example header.s=r1'
  const relayed = message({ headers: { 'authentication-results': [header] } })
  expect(assessDelivery(relayed, { authentication: { require: ['dkim'] } }, SOURCE).status).toBe('passed')
  const expected = assessDelivery(relayed, { authentication: { require: ['dkim'], domain: 'sender.example' } }, SOURCE)
  expect(expected.status).toBe('unverified')
  expect(expected.reason).toContain('dkim=fail for header.d=sender.example')
  expect(expected.reason).toContain('the DKIM key old._domainkey.sender.example')
})

test('the sending domain expected is the domain of the From header, and a subdomain of it aligns', () => {
  const wrong = assessDelivery(message({ from: 'App <no-reply@other.example>' }), { authentication: { require: ['dkim'], domain: 'sender.example' } }, SOURCE)
  expect(wrong.status).toBe('unverified')
  expect(wrong.reason).toContain('the message was sent from other.example, and the check expects sender.example')

  const subdomain = assessDelivery(message({ from: 'no-reply@mail.sender.example' }), { authentication: { require: ['spf', 'dkim'], domain: 'sender.example' } }, SOURCE)
  expect(subdomain.status).toBe('passed')
  // A domain that merely ends in the same letters does not.
  const lookalike = assessDelivery(message({ from: 'no-reply@evilsender.example' }), { authentication: { require: ['dkim'], domain: 'sender.example' } }, SOURCE)
  expect(lookalike.status).toBe('unverified')
})

test('a source that reports no authentication results leaves the assertion unverified, naming the source, never passed', () => {
  for (const headers of [undefined, {}, { 'authentication-results': ['mx.receiver.example; none'] }]) {
    const outcome = assessDelivery(message({ headers }), { authentication: { require: ['spf', 'dkim', 'dmarc'] } }, SOURCE)
    expect(outcome.status).toBe('unverified')
    expect(outcome.reason).toContain(SOURCE.describe)
    expect(outcome.reason).toContain('reports no authentication results from mx.receiver.example')
  }
  const sink = assessDelivery(message({ headers: {} }), { authentication: { require: ['dkim'] } }, CATCHER)
  expect(sink.status).toBe('unverified')
  expect(sink.reason).toContain('mailpit at the catcher is not declared as a receiver that judges mail')
  expect(sink.reason).toContain('a catcher in the stack receives mail without judging it')
})

// The application under test is the sender, and a sender can write this
// header. Against a source nobody declared to be a receiver, a message that
// vouches for itself proves nothing: it must never pass.
test('a header the sender could have written is never trusted: on a source that is no declared receiver, a passing header leaves the assertion unverified', () => {
  const forged = message({ headers: { 'authentication-results': [PASSING] } })
  const outcome = assessDelivery(forged, { authentication: { require: ['spf', 'dkim', 'dmarc'], domain: 'sender.example' } }, CATCHER)
  expect(outcome.status).toBe('unverified')
  expect(outcome.reason).toContain('the message carries an Authentication-Results header, but the sender can write one')
  expect(outcome.reason).toContain('mail.source.authserv')
  // Nothing of the header is recorded as a result: it was not read as one.
  expect(outcome.evidence).toBeUndefined()
  expect(outcome.summary).toBeUndefined()
})

test("only the declared receiver's own header counts, wherever it sits, and never one under another id", () => {
  const failing = 'mx.receiver.example; spf=fail smtp.mailfrom=sender.example; dkim=fail header.d=sender.example; dmarc=fail header.from=sender.example'
  // A header under another server's id, above or below, is not the receiver's verdict and cannot stand in for it.
  const relay = 'relay.internal; spf=pass smtp.mailfrom=sender.example; dkim=pass header.d=sender.example; dmarc=pass header.from=sender.example'
  for (const headers of [[relay, failing], [failing, relay]]) {
    const outcome = assessDelivery(message({ headers: { 'authentication-results': headers } }), { authentication: { require: ['dmarc'] } }, SOURCE)
    expect(outcome.status).toBe('unverified')
    expect(outcome.reason).toContain('dmarc=fail')
  }
  expect(assessDelivery(message({ headers: { 'authentication-results': [relay, PASSING] } }), { authentication: { require: ['dmarc'] } }, SOURCE).status).toBe('passed')

  const absent = assessDelivery(message({ headers: { 'authentication-results': [relay] } }), { authentication: { require: ['dmarc'] } }, SOURCE)
  expect(absent.status).toBe('unverified')
  expect(absent.reason).toContain('reports no authentication results from mx.receiver.example')
  expect(absent.reason).toContain('it carries results under relay.internal, which the profile does not name as its receiver')
})

test('a diagnostic names the property the receiver evaluated: SPF for the HELO name is not called the envelope sender', () => {
  const helo = 'mx.receiver.example; spf=fail smtp.helo=mta.sender.example'
  const outcome = assessDelivery(message({ headers: { 'authentication-results': [helo] } }), { authentication: { require: ['spf'] } }, SOURCE)
  expect(outcome.reason).toContain('spf=fail for smtp.helo=mta.sender.example; look at the SPF record of mta.sender.example')
  expect(outcome.reason).not.toContain('smtp.mailfrom')
  expect(parseAuthenticationResults(helo)?.results[0]).toMatchObject({ property: 'smtp.helo', domain: 'mta.sender.example' })
  // A DKIM result that names only the signing identity is named by it.
  const identity = assessDelivery(message({ headers: { 'authentication-results': ['mx.receiver.example; dkim=fail header.i=@mail.sender.example'] } }), { authentication: { require: ['dkim'] } }, SOURCE)
  expect(identity.reason).toContain('dkim=fail for header.i=mail.sender.example')
})

test('where the message landed is asserted from what the mailbox says, and a mailbox that does not say leaves it unverified', () => {
  const inbox = assessDelivery(message({ placement: 'inbox' }), { placement: 'inbox' }, SOURCE)
  expect(inbox.status).toBe('passed')
  expect(inbox.evidence).toEqual({ placement: 'inbox' })
  expect(inbox.summary).toBe('landed in inbox')

  const spam = assessDelivery(message({ placement: 'Spam' }), { placement: 'inbox' }, SOURCE)
  expect(spam.status).toBe('unverified')
  expect(spam.reason).toContain('the message landed in Spam, and the check expects inbox')

  const silent = assessDelivery(message(), { placement: 'inbox' }, SOURCE)
  expect(silent.status).toBe('unverified')
  expect(silent.reason).toContain(`${SOURCE.describe} does not say where a message landed`)
})

test('a check that asserts nothing about delivery is not assessed, whatever the message carries', () => {
  expect(assessDelivery(message({ headers: undefined }), {}, SOURCE)).toEqual({ status: 'passed' })
})
