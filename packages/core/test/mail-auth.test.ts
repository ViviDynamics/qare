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

const SOURCE = 'mailpit at the catcher'

test('an Authentication-Results header is read into the server that judged, each result and the domain it was evaluated for', () => {
  expect(parseAuthenticationResults(PASSING)).toEqual({
    authserv: 'mx.receiver.example',
    results: [
      { method: 'spf', result: 'pass', domain: 'bounce.sender.example', properties: { 'smtp.mailfrom': 'bounce.sender.example' } },
      { method: 'dkim', result: 'pass', domain: 'sender.example', selector: 's1', properties: { 'header.d': 'sender.example', 'header.s': 's1' } },
      { method: 'dmarc', result: 'pass', domain: 'sender.example', properties: { 'header.from': 'sender.example' } },
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
    expect(outcome.reason).toContain(SOURCE)
    expect(outcome.reason).toContain('reports no authentication results')
  }
})

test("only the receiving server's own header counts: the topmost, or the one the check names, never one the sender wrote", () => {
  const forged = 'mx.receiver.example; spf=pass smtp.mailfrom=sender.example; dkim=pass header.d=sender.example; dmarc=pass header.from=sender.example'
  const real = 'mx.receiver.example; spf=fail smtp.mailfrom=sender.example; dkim=fail header.d=sender.example; dmarc=fail header.from=sender.example'
  // Headers are listed top first, and a receiver adds its own above what it was sent.
  const stacked = message({ headers: { 'authentication-results': [real, forged] } })
  expect(assessDelivery(stacked, { authentication: { require: ['dmarc'] } }, SOURCE).status).toBe('unverified')

  const named = message({ headers: { 'authentication-results': ['relay.internal; dmarc=fail header.from=sender.example', PASSING] } })
  expect(assessDelivery(named, { authentication: { require: ['dmarc'], authserv: 'mx.receiver.example' } }, SOURCE).status).toBe('passed')
  const absent = assessDelivery(named, { authentication: { require: ['dmarc'], authserv: 'mx.other.example' } }, SOURCE)
  expect(absent.status).toBe('unverified')
  expect(absent.reason).toContain('no authentication results from mx.other.example')
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
  expect(silent.reason).toContain(`${SOURCE} does not say where a message landed`)
})

test('a check that asserts nothing about delivery is not assessed, whatever the message carries', () => {
  expect(assessDelivery(message({ headers: undefined }), {}, SOURCE)).toEqual({ status: 'passed' })
})
