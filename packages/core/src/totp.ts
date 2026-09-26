import { createHmac } from 'node:crypto'

/**
 * The TOTP a profile's seeded secret produces (RFC 6238), and the window
 * arithmetic around it (#64). The secret stays in the harness: a flow action
 * names an element and the harness generates the code for it, so no plan and
 * no model ever carries a secret or a code.
 */
export interface TotpConfig {
  secret: string
  digits: number
  period: number
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
}

const ALGORITHMS: TotpConfig['algorithm'][] = ['SHA1', 'SHA256', 'SHA512']
export const TOTP_ALGORITHMS = ALGORITHMS

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Decode an RFC 4648 base32 secret. Padding is optional and case-insensitive,
 * so a secret copied from an app's QR-setup page works as it is written.
 */
export function decodeBase32(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[=\s-]/g, '')
  if (clean.length === 0) throw new Error('the base32 secret is empty')
  if (/[01]/.test(clean)) throw new Error('the base32 secret carries a digit base32 does not use (0, 1)')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index === -1) throw new Error(`the base32 secret carries a character outside base32: ${JSON.stringify(char)}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** The window a time belongs to: `floor(epoch / period)`. */
export function totpWindow(period: number, at: number): number {
  return Math.floor(at / (period * 1000))
}

/** Milliseconds until the current window ends. */
export function windowRemaining(period: number, at: number): number {
  return period * 1000 - (at % (period * 1000))
}

/**
 * The code for one window. A window that has already ended codes for its own
 * instant: callers generate with the time they mean, and the flow runner
 * decides which window that is.
 */
export function totpCode(secret: string, config: TotpConfig, at: number): string {
  const key = decodeBase32(secret)
  const window = totpWindow(config.period, at)
  const counter = Buffer.alloc(8)
  counter.writeUInt32BE(Math.floor(window / 2 ** 32), 0)
  counter.writeUInt32BE(window % 2 ** 32, 4)
  const algorithm = ALGORITHMS.includes(config.algorithm) ? config.algorithm : 'SHA1'
  const digest = createHmac(algorithm, key).update(counter).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff)
  return String(binary % 10 ** config.digits).padStart(config.digits, '0')
}
