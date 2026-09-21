import { describe, expect, test } from 'vitest'
import { diffStubs, flagAddedStubs, type ProfileStub } from '../src/index.js'

const stub = (service: string, hosts: string[], composeService = `${service}-provider`): ProfileStub => ({
  service,
  hosts,
  provided_by: { compose_service: composeService },
})

describe('diffStubs', () => {
  test('identical stub lists are unchanged with nothing added or removed', () => {
    const base = [stub('payments', ['api.payments.example']), stub('mail', ['api.mail.example'])]
    const head = [stub('mail', ['api.mail.example']), stub('payments', ['api.payments.example'])]
    const diff = diffStubs(base, head)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.unchanged.map((s) => s.service)).toEqual(['mail', 'payments'])
  })

  test('a stub only in head is added', () => {
    const diff = diffStubs([stub('payments', ['api.payments.example'])], [
      stub('payments', ['api.payments.example']),
      stub('sms', ['api.sms-gateway.example']),
    ])
    expect(diff.added).toEqual([stub('sms', ['api.sms-gateway.example'])])
    expect(diff.removed).toEqual([])
  })

  test('a stub only in base is removed', () => {
    const diff = diffStubs([stub('payments', ['api.payments.example'])], [])
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([stub('payments', ['api.payments.example'])])
  })

  test('same service with changed hosts splits into added head version and removed base version', () => {
    const base = [stub('payments', ['api.payments.example'])]
    const head = [stub('payments', ['api.payments-v2.example'])]
    const diff = diffStubs(base, head)
    expect(diff.added).toEqual([stub('payments', ['api.payments-v2.example'])])
    expect(diff.removed).toEqual([stub('payments', ['api.payments.example'])])
    expect(diff.unchanged).toEqual([])
  })

  test('same service with a different compose service is a change', () => {
    const diff = diffStubs([stub('payments', ['api.payments.example'], 'old-provider')], [
      stub('payments', ['api.payments.example'], 'new-provider'),
    ])
    expect(diff.added).toEqual([stub('payments', ['api.payments.example'], 'new-provider')])
    expect(diff.removed).toEqual([stub('payments', ['api.payments.example'], 'old-provider')])
  })

  test('host order does not count as a change', () => {
    const diff = diffStubs(
      [stub('payments', ['a.example', 'b.example'])],
      [stub('payments', ['b.example', 'a.example'])],
    )
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.unchanged).toEqual([stub('payments', ['b.example', 'a.example'])])
  })

  test('results are sorted by service name regardless of input order', () => {
    const diff = diffStubs(
      [],
      [stub('mail', ['api.mail.example']), stub('billing', ['api.billing.example'])],
    )
    expect(diff.added.map((s) => s.service)).toEqual(['billing', 'mail'])
  })
})

describe('flagAddedStubs', () => {
  test('no change produces no findings and allows the run', () => {
    const diff = diffStubs([stub('payments', ['api.payments.example'])], [
      stub('payments', ['api.payments.example']),
    ])
    const result = flagAddedStubs(diff, { requiredServices: ['payments'] })
    expect(result.findings).toEqual([])
    expect(result.verdict).toBe('allowed')
  })

  test('an agent-added stub is flagged naming the service and hosts but allowed', () => {
    const diff = diffStubs([], [stub('sms', ['api.sms-gateway.example', 'fallback.sms.example'])])
    const result = flagAddedStubs(diff, { requiredServices: [] })
    expect(result.findings).toEqual([
      'stub-added-in-change: sms (hosts: api.sms-gateway.example, fallback.sms.example)',
    ])
    expect(result.verdict).toBe('allowed')
  })

  test('an added required stub refuses the run', () => {
    const diff = diffStubs([], [stub('payments', ['api.payments.example'])])
    const result = flagAddedStubs(diff, { requiredServices: ['payments'] })
    expect(result.findings).toEqual(['stub-added-in-change: payments (hosts: api.payments.example)'])
    expect(result.verdict).toBe('refused')
  })

  test('a modified required stub is flagged off the head version and refuses', () => {
    const base = [stub('payments', ['api.payments.example'])]
    const head = [stub('payments', ['api.payments-v2.example'])]
    const diff = diffStubs(base, head)
    const result = flagAddedStubs(diff, { requiredServices: ['payments'] })
    expect(diff.removed).toEqual([stub('payments', ['api.payments.example'])])
    expect(diff.added).toEqual([stub('payments', ['api.payments-v2.example'])])
    expect(result.findings).toEqual(['stub-added-in-change: payments (hosts: api.payments-v2.example)'])
    expect(result.verdict).toBe('refused')
  })

  test('a modified non-required stub is flagged but allowed', () => {
    const diff = diffStubs([stub('mail', ['api.mail.example'])], [stub('mail', ['api.mail-v2.example'])])
    const result = flagAddedStubs(diff, { requiredServices: ['payments'] })
    expect(result.findings).toEqual(['stub-added-in-change: mail (hosts: api.mail-v2.example)'])
    expect(result.verdict).toBe('allowed')
  })

  test('mixed required and non-required additions refuse and cannot be masked', () => {
    const diff = diffStubs(
      [],
      [stub('sms', ['api.sms-gateway.example']), stub('payments', ['api.payments.example'])],
    )
    const result = flagAddedStubs(diff, { requiredServices: ['payments'] })
    expect(result.findings).toEqual([
      'stub-added-in-change: payments (hosts: api.payments.example)',
      'stub-added-in-change: sms (hosts: api.sms-gateway.example)',
    ])
    expect(result.verdict).toBe('refused')
  })

  test('duplicate requiredServices entries are deduplicated', () => {
    const diff = diffStubs([], [stub('payments', ['api.payments.example'])])
    const result = flagAddedStubs(diff, { requiredServices: ['payments', 'payments'] })
    expect(result.findings).toEqual(['stub-added-in-change: payments (hosts: api.payments.example)'])
    expect(result.verdict).toBe('refused')
  })

  test('duplicate requiredServices entries do not duplicate findings for non-required stubs', () => {
    const diff = diffStubs([], [stub('sms', ['api.sms-gateway.example'])])
    const result = flagAddedStubs(diff, { requiredServices: ['payments', 'payments'] })
    expect(result.findings).toEqual(['stub-added-in-change: sms (hosts: api.sms-gateway.example)'])
    expect(result.verdict).toBe('allowed')
  })
})
