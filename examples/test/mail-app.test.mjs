// The example whose stack carries a real mail catcher (#65), held together
// without docker: its profile declares the catcher as its mail source, its
// plan waits at the address the run mints, and the script CI runs against it
// goes through the pipeline's own execute steps. The boot, the message and
// the two concurrent waits are CI's mail-sink job, which needs a docker
// daemon this suite must not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlan, loadProfile } from '../../packages/core/dist/index.js'
import { mailMessage } from '../mail-app/smtp.mjs'

const example = fileURLToPath(new URL('../mail-app/', import.meta.url))
const root = fileURLToPath(new URL('../../', import.meta.url))

test('the mail-app profile reads its mail from the catcher in its own stack', async () => {
  const profile = await loadProfile(join(example, '.qa'))
  assert.deepEqual(profile.app.boot, { compose: 'examples/mail-app/compose.yaml', service: 'web' })
  // The catcher is published behind the one port a run mints, so two runs
  // never share a catcher and the source needs no second port.
  assert.deepEqual(profile.mail, { source: { kind: 'mailpit', url: 'http://localhost:{{run.app_port}}/mailpit' } })
  const compose = await readFile(join(example, 'compose.yaml'), 'utf8')
  assert.match(compose, /\$\{QARE_APP_PORT:-3000\}:3000/)
  // The catcher is a pinned image the stack provides, like any other stub,
  // and it publishes no port of its own.
  assert.match(compose, /image: axllent\/mailpit:v\d+\.\d+/)
  assert.equal(compose.match(/ports:/g)?.length, 1)
})

test('the mail-app plan makes the app send, waits at the minted address, then follows the link it read', async () => {
  const plan = loadPlan(await readFile(join(example, 'plan.json'), 'utf8'))
  const [sent, confirmed] = plan.criteria
  assert.equal(plan.criteria.length, 2)
  // The check that makes the app send comes before the mail check, in the
  // same criterion: the wait opens with the criterion.
  assert.deepEqual(sent.checks.map((check) => check.kind), ['command', 'mail'])
  assert.match(sent.checks[0].command, /\/signup\?email=\{\{run\.mail_address\}\}/)
  const mail = sent.checks[1]
  assert.equal(mail.address, '{{run.mail_address}}')
  assert.equal(mail.subject, 'Confirm your account')
  assert.deepEqual(mail.code, {})
  assert.match(confirmed.checks[0].command, new RegExp(`\\{\\{mail\\.${mail.name}\\.link\\}\\}`))
})

test('the message the app sends carries the link and the code the plan reads', () => {
  const message = mailMessage({ to: 'qare-1@localhost', origin: 'http://localhost:3000', account: 7, code: '482913' })
  assert.equal(message.subject, 'Confirm your account')
  assert.match(message.from, /no-reply@mail-app\.example/)
  assert.match(message.text, /http:\/\/localhost:3000\/confirm\?account=7/)
  assert.match(message.text, /482913/)
})

test('the script CI runs goes through the pipeline execute steps, then two waits on one catcher', async () => {
  const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8')
  assert.match(ci, /\n {2}mail-sink:\n/)
  assert.match(ci, /run: scripts\/mail-sink\.sh qare-core:ci/)
  const script = await readFile(join(root, 'scripts/mail-sink.sh'), 'utf8')
  for (const name of ["Find the runner's docker", 'Run the plan', 'Tear down what the run booted'])
    assert.match(script, new RegExp(`step ["']${name}["']`))
  assert.match(script, /PROFILE=examples\/mail-app\/\.qa/)
  assert.match(script, /node examples\/mail-app\/concurrent\.mjs/)
})
