import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { redactText } from '../src/redact.js'

const exec = promisify(execFile)
const checkout = fileURLToPath(new URL('../../../', import.meta.url))
const script = fileURLToPath(new URL('../../../.qa/checks/mail-evidence.mjs', import.meta.url))

// The self-run must exercise the changed source, not the image's base build
// or a grep over the implementation. A missing assertion or a loader that
// cannot execute the source makes one of these checks fail.
test.each(['quoted-auth', 'missing-code'])('the raw-checkout mail self-check executes %s and reports observed evidence', async (check) => {
  const { stdout } = await exec(process.execPath, [script, check], { cwd: checkout })
  const observed = JSON.parse(redactText(stdout))
  expect(observed.check).toBe(check)
  if (check === 'quoted-auth') {
    expect(observed.reason).toBe('policy = reject; spf = pass')
    expect(observed.selector).toBe('key = one')
  } else {
    expect(observed.outcome).toBe('unverified')
    expect(observed.reason).toContain('carries no one-time code')
    expect(observed.message.evaluatedResults).toEqual([{ method: 'dkim', result: 'pass', domain: 'example.test', aligned: true }])
    expect(observed.message.placement).toBe('inbox')
    expect(observed.message.receiver).toBe('mx.receiver.example')
    expect(observed.proof.delivery).toContain('dkim=pass')
  }
})

test('the mail self-check refuses an unknown check rather than passing without assertions', async () => {
  await expect(exec(process.execPath, [script, 'unknown'], { cwd: checkout })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('unknown mail self-check') })
})

// The http check self-checks (#378) run the checkout's source the same way,
// and each prints what it observed under its own name.
const httpScript = fileURLToPath(new URL('../../../.qa/checks/http-check.mjs', import.meta.url))
test.each(['plan', 'evidence', 'judge', 'planner'])('the raw-checkout http self-check executes %s and reports what it observed', async (check) => {
  const { stdout } = await exec(process.execPath, [httpScript, check], { cwd: checkout })
  expect(stdout.replace(/\s+/g, '')).toContain(`"check":"${check}"`)
  if (check === 'judge') expect(stdout).toContain('the response status was 422, expected 201')
  if (check === 'evidence') expect(stdout).toContain('"set-cookie": "[redacted]"')
})
