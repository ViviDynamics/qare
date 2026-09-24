import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  BUILTIN_REDACTION_RULES,
  REDACTED,
  RedactionError,
  redactEvidenceDir,
  redactResult,
  redactText,
  redactValue,
  redactionRules,
  type RunResult,
} from '../src/index.js'

// Assembled at runtime so no literal token sits in the repository for a
// secret scanner to flag.
const GITHUB_TOKEN = ['ghp', '_', 'Ab1'.repeat(12)].join('')
const ANTHROPIC_KEY = ['sk', '-ant-', 'x'.repeat(40)].join('')
const FINE_GRAINED = ['github', '_pat_', 'A1'.repeat(20)].join('')
const AWS_KEY_ID = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
const SLACK = ['xoxb', '-', '1234567890-abcdef'].join('')
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.')
const PRIVATE_KEY = ['-----BEGIN RSA PRIVATE', ' KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE', ' KEY-----'].join('')

test('the known token shapes are redacted wherever they appear', () => {
  for (const secret of [GITHUB_TOKEN, ANTHROPIC_KEY, FINE_GRAINED, AWS_KEY_ID, SLACK, JWT, PRIVATE_KEY]) {
    const redacted = redactText(`before ${secret} after`)
    expect(redacted, secret).not.toContain(secret)
    expect(redacted).toContain(REDACTED)
    expect(redacted.startsWith('before ')).toBe(true)
  }
})

test('a key or password assignment keeps its name and loses its value', () => {
  expect(redactText('AUTH_TOKEN=abc123 next')).toBe(`AUTH_TOKEN=${REDACTED} next`)
  expect(redactText('Authorization: Bearer abc.def')).toBe(`Authorization: ${REDACTED}`)
  expect(redactText('"password": "hunter2"')).toBe(`"password": "${REDACTED}`)
  expect(redactText('db_password = s3cret')).toBe(`db_password = ${REDACTED}`)
})

test('a password in a url is redacted and the rest of the url kept', () => {
  const url = ['postgres', '://app:', 's3cret', '@db:5432/app'].join('')
  expect(redactText(url)).toBe(['postgres', '://app:', REDACTED, '@db:5432/app'].join(''))
})

test('a private key cut off at the capture limit is redacted to the end', () => {
  const cut = ['-----BEGIN OPENSSH PRIVATE', ' KEY-----\nb3BlbnNzaC1rZXk\n[truncated at 1 MiB]\n'].join('')
  expect(redactText(`key:\n${cut}`)).toBe(`key:\n${REDACTED}`)
})

test('redaction is idempotent, so the sweep after a run changes nothing', () => {
  const once = redactText(`token=${GITHUB_TOKEN} and ${AWS_KEY_ID} ${PRIVATE_KEY}`)
  expect(redactText(once)).toBe(once)
})

test('ordinary output is left alone', () => {
  const output = 'Tests: 12 passed, 0 failed\nGET /up 200 in 4ms\nauthor Jane wrote 3 files\n'
  expect(redactText(output)).toBe(output)
})

test('a long run of word characters does not backtrack for seconds', () => {
  const blob = `${'token'.repeat(200_000)}\n${'a'.repeat(1_000_000)}`
  const started = Date.now()
  redactText(blob)
  expect(Date.now() - started).toBeLessThan(2000)
})

test('profile values and patterns are redacted before the built-in rules', () => {
  const rules = redactionRules({ values: ['jane@pilot.example'], patterns: ['CUST-\\d{6}'] })
  expect(rules.slice(2)).toEqual(BUILTIN_REDACTION_RULES)
  expect(redactText('mailed jane@pilot.example about CUST-004211 (a.b)', rules)).toBe(
    `mailed ${REDACTED} about ${REDACTED} (a.b)`,
  )
})

test('a profile value is literal, not a pattern', () => {
  const rules = redactionRules({ values: ['a.b'] })
  expect(redactText('axb a.b', rules)).toBe(`axb ${REDACTED}`)
})

test('a profile pattern that does not compile, or matches nothing at all, is refused', () => {
  expect(() => redactionRules({ patterns: ['(unclosed'] })).toThrow(RedactionError)
  expect(() => redactionRules({ patterns: ['x*'] })).toThrow(/matches the empty string/)
})

test('a JSON value is redacted in its strings and under keys that name a secret', () => {
  expect(redactValue({ note: `used ${GITHUB_TOKEN}`, password: 'hunter2', nested: [{ apiKey: 'k' }], count: 3 })).toEqual({
    note: `used ${REDACTED}`,
    password: REDACTED,
    nested: [{ apiKey: REDACTED }],
    count: 3,
  })
})

test('a result keeps its ids and evidence paths and loses secrets from its reasons', () => {
  const result: RunResult = {
    schemaVersion: '1',
    verdict: 'blocked',
    criteria: [
      { id: 'token:1', outcome: 'proven', evidence: ['checks/token:1/0/stdout.txt'] },
      { id: 'c2', outcome: 'unverified', reason: `boot failed: ${GITHUB_TOKEN} rejected` },
    ],
  }
  expect(redactResult(result)).toEqual({
    ...result,
    criteria: [result.criteria[0], { id: 'c2', outcome: 'unverified', reason: `boot failed: ${REDACTED} rejected` }],
  })
})

async function evidenceDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'qare-redact-'))
}

test('the sweep redacts text files in place and reports what it changed', async () => {
  const dir = await evidenceDir()
  await mkdir(join(dir, 'checks', 'c1', '0'), { recursive: true })
  await writeFile(join(dir, 'checks', 'c1', '0', 'stdout.txt'), `pushed with ${GITHUB_TOKEN}\n`)
  await writeFile(join(dir, 'checks', 'c1', '0', 'stderr.txt'), 'nothing here\n')

  const report = await redactEvidenceDir(dir)

  expect(report).toEqual({
    files: [join('checks', 'c1', '0', 'stderr.txt'), join('checks', 'c1', '0', 'stdout.txt')],
    changed: [join('checks', 'c1', '0', 'stdout.txt')],
    images: [],
  })
  expect(await readFile(join(dir, 'checks', 'c1', '0', 'stdout.txt'), 'utf8')).toBe(`pushed with ${REDACTED}\n`)
  expect(await readFile(join(dir, 'checks', 'c1', '0', 'stderr.txt'), 'utf8')).toBe('nothing here\n')
})

test('the sweep redacts result.json reasons and leaves its ids alone', async () => {
  const dir = await evidenceDir()
  const result: RunResult = {
    schemaVersion: '1',
    verdict: 'blocked',
    criteria: [{ id: 'secret=1', outcome: 'unverified', reason: `compose said ${AWS_KEY_ID}` }],
  }
  await writeFile(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)

  await redactEvidenceDir(dir)

  expect(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))).toEqual({
    ...result,
    criteria: [{ id: 'secret=1', outcome: 'unverified', reason: `compose said ${REDACTED}` }],
  })
})

test('a result.json that does not parse stops the sweep', async () => {
  const dir = await evidenceDir()
  await writeFile(join(dir, 'result.json'), '{"verdict": ')
  await expect(redactEvidenceDir(dir)).rejects.toThrow(/result.json is not a valid result/)
})

test('an image is published as captured, and other binaries stop the sweep', async () => {
  const dir = await evidenceDir()
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  await writeFile(join(dir, 'head.png'), png)
  expect((await redactEvidenceDir(dir)).images).toEqual(['head.png'])
  expect(await readFile(join(dir, 'head.png'))).toEqual(png)

  await writeFile(join(dir, 'trace.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]))
  await expect(redactEvidenceDir(dir)).rejects.toThrow(/trace.zip is neither text nor an image/)
})

test('a symlink in the evidence stops the sweep', async () => {
  const dir = await evidenceDir()
  await symlink('/etc/hostname', join(dir, 'link.txt'))
  await expect(redactEvidenceDir(dir)).rejects.toThrow(/link.txt is not a regular file/)
})

test('a missing evidence directory is an error, not an empty success', async () => {
  const dir = await evidenceDir()
  await expect(redactEvidenceDir(join(dir, 'absent'))).rejects.toThrow(RedactionError)
})
