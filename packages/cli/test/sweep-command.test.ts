import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

async function ledgerDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'qare-sweep-cli-'))
}

test('sweep of an empty ledger reports all buckets empty and exits clean', async () => {
  const dir = await ledgerDir()
  try {
    const { lines, writer } = capture()
    const code = await main(['sweep', '--ledger', dir], writer, { write: () => {} })
    expect(code).toBe(0)
    expect(lines.join('')).toContain('proven: 0 stale: 0 unverified: 0 quarantined: 0 refused: 0')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('sweep writes the payload the publish step consumes with --out', async () => {
  const dir = await ledgerDir()
  try {
    const out = join(dir, '..', 'payload.json')
    const { writer } = capture()
    const code = await main(['sweep', '--ledger', dir, '--out', out], writer, { write: () => {} })
    expect(code).toBe(0)
    const payload = JSON.parse(await readFile(out, 'utf8'))
    expect(payload.at).toBeTruthy()
    expect(payload.ledger).toBe(dir)
    expect(payload.findings).toEqual([])
    expect(payload.classification).toMatchObject({ proven: [], stale: [], unverified: [], quarantined: [], refused: [] })
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('sweep reports a ledger it cannot read as a finding, and still exits clean', async () => {
  const dir = await ledgerDir()
  try {
    await writeFile(join(dir, 'ledger.json'), '{"entries":', 'utf8')
    const { lines, writer } = capture()
    const err = capture()
    const code = await main(['sweep', '--ledger', dir, '--json'], writer, err.writer)
    expect(code).toBe(0)
    const payload = JSON.parse(lines.join(''))
    expect(payload.findings).toHaveLength(1)
    expect(payload.findings[0].fingerprint).toBe('sweep:ledger-unreadable')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('sweep refuses a --ledger without a directory value', async () => {
  const { writer } = capture()
  const err = capture()
  const code = await main(['sweep', '--ledger'], writer, err.writer)
  expect(code).toBe(1)
  expect(err.lines.join('')).toContain('qare sweep requires a directory value after --ledger')
})

test('sweep prints a finding line in text mode', async () => {
  const dir = await ledgerDir()
  try {
    await writeFile(join(dir, 'ledger.json'), '{"entries":', 'utf8')
    const { lines, writer } = capture()
    const code = await main(['sweep', '--ledger', dir], writer, { write: () => {} })
    expect(code).toBe(0)
    expect(lines.join('')).toContain('finding: sweep:ledger-unreadable')
  } finally {
    await rm(dir, { recursive: true })
  }
})
