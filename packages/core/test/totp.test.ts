import { expect, test } from 'vitest'
import { decodeBase32, totpCode, totpWindow, windowRemaining } from '../src/index.js'

// The RFC 6238 §B test vector: the ASCII secret "12345678901234567890" in
// base32, SHA-1, eight digits. Every code below is the standard's answer for
// its window, so a code qare types is the app's own math, not ours.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const RFC_CASES: [seconds: number, code: string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

test('generates the RFC 6238 test vectors', () => {
  for (const [seconds, code] of RFC_CASES) {
    expect(totpCode(RFC_SECRET, { secret: RFC_SECRET, digits: 8, period: 30, algorithm: 'SHA1' }, seconds * 1000)).toBe(code)
  }
})

test('generates the six-digit code an app with default settings expects', () => {
  expect(totpCode(RFC_SECRET, { secret: RFC_SECRET, digits: 6, period: 30, algorithm: 'SHA1' }, 59_000)).toBe('287082')
})

test('codes shift with the algorithm and digit count the profile declares', () => {
  // RFC 6238 §B, eight digits. The SHA-256 and SHA-512 vectors use their own
  // 32- and 64-byte seeds, as the RFC's appendix specifies.
  const sha256Secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA'
  const sha512Secret =
    'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA'
  expect(totpCode(sha256Secret, { secret: sha256Secret, digits: 8, period: 30, algorithm: 'SHA256' }, 59_000)).toBe('46119246')
  expect(totpCode(sha512Secret, { secret: sha512Secret, digits: 8, period: 30, algorithm: 'SHA512' }, 59_000)).toBe('90693936')
})

test('window arithmetic counts whole periods and reports what is left of one', () => {
  expect(totpWindow(30, 59_000)).toBe(1)
  expect(windowRemaining(30, 59_000)).toBe(1000)
  expect(totpWindow(30, 60_000)).toBe(2)
  expect(windowRemaining(30, 60_000)).toBe(30_000)
})

test('base32 secrets tolerate padding, whitespace and lowercase, and reject what is not base32', () => {
  expect(decodeBase32('GEZDGNBVGY3TQOJQ=')).toEqual(decodeBase32('GEZDGNBVGY3TQOJQ'))
  expect(decodeBase32('gezd gnbvgy 3tqojqg')).toEqual(decodeBase32('GEZDGNBVGY3TQOJQG'))
  expect(decodeBase32('gezdgnbvgy3tqojqg')).toEqual(decodeBase32('GEZDGNBVGY3TQOJQG'))
  expect(() => decodeBase32('')).toThrow('empty')
  expect(() => decodeBase32('GEZDGN01')).toThrow(/digit base32 does not use/)
  expect(() => decodeBase32('GEZDGNB!')).toThrow(/outside base32/)
})
