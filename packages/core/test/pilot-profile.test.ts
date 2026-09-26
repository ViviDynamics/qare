import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { loadProfile } from '../src/index.js'

const exampleDir = fileURLToPath(new URL('../../../examples/pilot-admin/.qa', import.meta.url))
const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

test('the pilot admin console example profile loads with the expected shape', async () => {
  const profile = await loadProfile(exampleDir)

  expect(profile.app.boot).toEqual({ compose: 'compose.qa.yaml', service: 'admin' })
  expect(profile.app.health).toEqual({ http: HEALTH_URL, timeout: '120s' })
  expect(profile.app.seed).toEqual({ command: 'bin/rails db:seed:qa' })
  expect(profile.app.login).toEqual({
    fixture: 'fixtures/users.yml',
    role: 'admin',
    totp: { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', digits: 6, period: 30, algorithm: 'SHA1' },
  })

  expect(profile.stubs).toEqual([
    {
      service: 'billing',
      hosts: ['api.stripe.example', 'files.stripe.example'],
      provided_by: { compose_service: 'billing-stub' },
    },
    {
      service: 'mail',
      hosts: ['smtp.postmark.example'],
      provided_by: { compose_service: 'mailpit' },
    },
  ])

  expect(profile.visual).toEqual({ widths: [1440, 390], themes: ['light', 'dark'] })

  expect(profile.suites).toEqual([
    { name: 'rails-system', command: 'bin/rails test:system', kind: 'command' },
  ])
})

test('the pilot admin console example ships non-empty QA.md instructions', async () => {
  const qaMd = readFileSync(join(exampleDir, 'QA.md'), 'utf8')

  expect(qaMd.trim().length).toBeGreaterThan(0)
})
