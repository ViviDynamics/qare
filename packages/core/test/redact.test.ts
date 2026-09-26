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
  validateMaskSelectors,
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

test('profile values and patterns are redacted after the built-in rules', () => {
  const rules = redactionRules({ values: ['jane@pilot.example'], patterns: ['CUST-\\d{6}'] })
  expect(rules.slice(0, BUILTIN_REDACTION_RULES.length)).toEqual(BUILTIN_REDACTION_RULES)
  expect(rules).toHaveLength(BUILTIN_REDACTION_RULES.length + 2)
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

test('a secret-named key loses its value whatever its type, and a key that only contains the word keeps it', () => {
  expect(
    redactValue({
      password: 123456,
      token: { value: 's3cr3t' },
      accessToken: 'abc',
      db_password: 'x',
      author: 'jane',
      oauthProvider: 'github',
      tokenizer: 'bpe',
      missing: null,
    }),
  ).toEqual({
    password: REDACTED,
    token: REDACTED,
    accessToken: REDACTED,
    db_password: REDACTED,
    author: 'jane',
    oauthProvider: 'github',
    tokenizer: 'bpe',
    missing: null,
  })
})

test('a file and line reference is not a key and its value', () => {
  const output = '[chromium] › tests/auth.spec.ts:12:5 › logs in\n    at refresh (src/token.ts:42:10)\n'
  expect(redactText(output)).toBe(output)
  expect(redactText('password:1234')).toBe(`password:${REDACTED}`)
})

test('a profile value inside a key cannot shield the key from the built-in rule', () => {
  const rules = redactionRules({ values: ['api'] })
  expect(redactText('api_key=abcd1234secret', rules)).not.toContain('abcd1234secret')
})

test('a profile pattern that matches nothing only in context redacts nothing', () => {
  const rules = redactionRules({ patterns: ['\\b', '(?=CUST)'] })
  expect(redactText('CUST-123 ok', rules)).toBe('CUST-123 ok')
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

test('the sweep keeps result.json fields it does not know', async () => {
  const dir = await evidenceDir()
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify({
      schemaVersion: '1',
      verdict: 'blocked',
      notes: 'from a newer writer',
      criteria: [{ id: 'c1', outcome: 'unverified', reason: `saw ${AWS_KEY_ID}`, extra: 1 }],
    }),
  )

  await redactEvidenceDir(dir)

  expect(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))).toEqual({
    schemaVersion: '1',
    verdict: 'blocked',
    notes: 'from a newer writer',
    criteria: [{ id: 'c1', outcome: 'unverified', reason: `saw ${REDACTED}`, extra: 1 }],
  })
})

test('a text file that opens with an image signature is redacted as text', async () => {
  const dir = await evidenceDir()
  await writeFile(join(dir, 'gif.txt'), `GIF89a ${GITHUB_TOKEN}\n`)
  await writeFile(join(dir, 'webp.txt'), `12345678WEBP ${GITHUB_TOKEN}\n`)

  const report = await redactEvidenceDir(dir)

  expect(report.images).toEqual([])
  expect(report.changed).toEqual(['gif.txt', 'webp.txt'])
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

// The mask grammar mirrors playwright-core's own selector parser, so these
// cases come from how it decides: the `>>` split, the engine-name inference,
// the capture part, and the engine registry.
test('mask selectors playwright can resolve are accepted (#119)', () => {
  expect(() =>
    validateMaskSelectors([
      'css=.fixture-banner',
      '.fixture-banner',
      '//div[@class="fixture-banner"]',
      '(//div)[2]',
      '..',
      '"jane@pilot.example"',
      "'jane@pilot.example'",
      'text=jane@pilot.example',
      'id=sign-in',
      'data-testid=fixture-email',
      'nth=0',
      'role=button[name="Sign in"]',
      'css=.a >> .inner >> button[type="submit"]',
      // Quotes protect a `>>` from chaining, in text and css alike.
      'text="a >> b"',
      'css=[title="a >> b"]',
      // A quote in a text part's body does not open a quote context, so the
      // chain still splits; playwright parses this as text `a` and css `b`.
      'text=a >> b',
      '*css=.banner',
    ]),
  ).not.toThrow()
})

test('mask selectors playwright cannot resolve are refused, naming the mask (#119)', () => {
  for (const invalid of [
    '',
    '   ',
    'css=.a >>    ',
    'css=',
    'text=',
    'foo=.fixture-banner',
    'internal:has=text=x',
    '*=text',
    'css=[data-x',
    'css=[title="unterminated',
    '*css=.a >> *css=.b',
  ]) {
    let message: string | undefined
    try {
      validateMaskSelectors([invalid])
    } catch (error) {
      message = (error as Error).message
    }
    expect(message, invalid).toBeDefined()
    expect(message!.startsWith('redact mask'), invalid).toBe(true)
    expect(message, invalid).toContain(JSON.stringify(invalid))
  }
})

test('an absent mask list validates to nothing', () => {
  expect(() => validateMaskSelectors(undefined)).not.toThrow()
  expect(() => validateMaskSelectors([])).not.toThrow()
})
