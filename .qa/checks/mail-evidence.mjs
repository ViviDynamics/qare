import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './source.mjs'

const check = process.argv[2]
if (check === 'quoted-auth') {
  const { parseAuthenticationResults } = await import('../../packages/core/src/mail-auth.ts')
  const parsed = parseAuthenticationResults('mx.receiver.example; dkim = fail reason = "policy = reject; spf = pass" header.s = "key = one" header.d = sender.example')
  assert.equal(parsed.results.length, 1)
  const observed = parsed.results[0]
  assert.equal(observed.reason, 'policy = reject; spf = pass')
  assert.equal(observed.selector, 'key = one')
  assert.equal(observed.result, 'fail')
  console.log(JSON.stringify({ check, ...observed }))
} else if (check === 'missing-code') {
  const { runJob } = await import('../../packages/core/src/run.ts')
  const scratch = fileURLToPath(new URL('./scratch/', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const repo = await mkdtemp(join(scratch, 'mail-'))
  try {
    const url = ['http:', '//mailbox.example.test'].join('')
    const profile = {
      app: {
        boot: { compose: 'compose.qa.yaml', service: 'app' },
        health: { http: ['http:', '//localhost:3000/up'].join(''), timeout: '120s' },
        seed: { command: 'true' },
        login: { fixture: 'fixtures/users.yml', role: 'admin' },
      },
      stubs: [], visual: { widths: [], themes: [] }, suites: [],
      mail: { source: { kind: 'inbox', url, authserv: 'mx.receiver.example' } },
    }
    const job = {
      id: 'mail-self-check', repoPath: repo, baseRef: 'main', headRef: 'HEAD',
      profile: { inline: profile }, evidenceDir: join(repo, 'evidence'), post: 'none',
      criteria: [{
        id: 'mail', text: 'a missing code retains delivery evidence',
        checks: [{ kind: 'mail', name: 'welcome', address: 'qa@localhost', code: {}, authentication: { require: ['dkim'] }, placement: 'inbox' }],
      }],
    }
    const { result } = await runJob(job, {
      runCompose: async () => ({ code: 0, stdout: '', stderr: '' }),
      probe: async () => ({ ok: true }),
      readMail: async () => [{
        from: 'App <no-reply@example.test>', subject: 'Welcome', body: 'A message with no code.',
        received_at: new Date(Date.now() + 5).toISOString(),
        headers: { 'authentication-results': ['mx.receiver.example; dkim=pass header.d=example.test'] },
        placement: 'inbox',
      }],
    })
    const criterion = result.criteria[0]
    assert.equal(criterion.outcome, 'unverified')
    assert.match(criterion.reason, /carries no one-time code/)
    const message = JSON.parse(await readFile(join(job.evidenceDir, 'checks/mail/0/message.json'), 'utf8'))
    assert.deepEqual(message.authentication.results, [{ method: 'dkim', result: 'pass', domain: 'example.test', aligned: true }])
    assert.equal(message.placement, 'inbox')
    const proof = criterion.mail[0]
    assert.match(proof.delivery, /dkim=pass/)
    // The stream redactor treats keys starting with "auth" as credentials.
    // Emit the observed receiver/results under neutral names so it cannot
    // consume the remaining JSON; the actual message.json stays untouched.
    const { authentication, ...record } = message
    console.log(JSON.stringify({
      check, outcome: criterion.outcome, reason: criterion.reason,
      message: { ...record, receiver: authentication.authserv, evaluatedResults: authentication.results }, proof,
    }))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
} else {
  throw new Error(`unknown mail self-check: ${check}`)
}
