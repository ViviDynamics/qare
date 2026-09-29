import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { criterionIdFor, integrityOf, LEDGER_SCHEMA_VERSION, WRITING_CRITERIA_GUIDE } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { text: () => string; writer: Writer } {
  const lines: string[] = []
  return { text: () => lines.join(''), writer: { write: (chunk) => lines.push(chunk) } }
}

const CHECKABLE = 'the payouts page shows the 1099 notice for a host paid past the annual threshold'
const VAGUE = 'the article is pleasant to read'
const CARRIED = 'ingest never writes the ledger itself'

const PLAN = {
  schemaVersion: '1',
  criteria: [
    {
      id: criterionIdFor(CHECKABLE),
      text: CHECKABLE,
      checks: [{ kind: 'command', name: 'notice', command: 'node notice.mjs' }],
    },
    { id: criterionIdFor(VAGUE), text: VAGUE, unplannable: 'pleasant is not something a check can show' },
  ],
}

async function fakeNare(plan: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-ingest-nare-'))
  const script = [
    `const answer = ${JSON.stringify(JSON.stringify(plan))}`,
    "console.log(JSON.stringify({ type: 'result', status: 'done', questions: [], usage: { input: 1, output: 1 },",
    "  stop_reason: 'end_turn', turns: 1, contract: 1, output: JSON.parse(answer), error: null }))",
  ].join('\n')
  await writeFile(join(dir, 'nare.mjs'), script)
  const binary = join(dir, 'nare')
  await writeFile(binary, `#!/bin/sh\nexec node ${join(dir, 'nare.mjs')} "$@"\n`)
  await chmod(binary, 0o755)
  return binary
}

async function ledgerDirWithCarried(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-ingest-ledger-'))
  const entries = [
    { criterion: criterionIdFor(CARRIED), status: 'active', source: [link('example.test', '/issues/9')], proof: 'command' },
  ]
  await writeFile(
    join(dir, 'ledger.json'),
    `${JSON.stringify({ entries, schemaVersion: LEDGER_SCHEMA_VERSION, integrity: integrityOf(entries) }, null, 2)}\n`,
  )
  return dir
}

const link = (host: string, path: string) => ['https:', `//${host}${path}`].join('')

test('ingest proposes what the ledger lacks, keeps duplicates back, and queues one comment for the uncheckable', async () => {
  const nare = await fakeNare(PLAN)
  const ledger = await ledgerDirWithCarried()
  const work = await mkdtemp(join(tmpdir(), 'qare-ingest-'))
  const issueBody = `## Acceptance criteria\n\n- [ ] ${CHECKABLE}\n- [ ] ${VAGUE}\n- [ ] ${CARRIED}\n`
  const bodyPath = join(work, 'issue-37.md')
  await writeFile(bodyPath, issueBody)
  const manifestPath = join(work, 'sources.json')
  await writeFile(
    manifestPath,
    `${JSON.stringify({ sources: [{ kind: 'issue', number: 37, author: 'Jason733i', link: link('example.test', '/issues/37'), body: bodyPath }] })}\n`,
  )
  const outDir = join(work, 'out')
  const out = capture()
  const err = capture()

  const code = await main(
    ['ingest', '--sources', manifestPath, '--ledger', ledger, '--out', outDir, '--nare', nare],
    out.writer,
    err.writer,
  )

  expect(err.text()).toBe('')
  expect(code).toBe(0)
  expect(out.text()).toContain('1 proposed, 1 already carried, 1 uncheckable')
  const proposal = JSON.parse(await readFile(join(outDir, 'ingest-proposal.json'), 'utf8'))
  expect(proposal.baseFingerprint).toBe(integrityOf(JSON.parse(await readFile(join(ledger, 'ledger.json'), 'utf8')).entries))
  expect(proposal.ledgerText).toContain('"status": "proposed"')
  expect(proposal.ledgerText).not.toContain(criterionIdFor(VAGUE))
  expect(proposal.branch).toMatch(/^qare-ledger-proposal-[0-9a-f]{8}$/)
  expect(proposal.sources[0]!.link).toBe(link('example.test', '/issues/37'))
  expect(proposal.body).toContain(WRITING_CRITERIA_GUIDE)
  const comments = JSON.parse(await readFile(join(outDir, 'ingest-comments.json'), 'utf8'))
  expect(comments).toHaveLength(1)
  expect(comments[0]!.issue).toBe(37)
  expect(comments[0]!.body).toContain('@Jason733i')
  expect(comments[0]!.body).toContain('pleasant is not something a check can show')
})

test('ingest names what is missing and refuses to run without it', async () => {
  const out = capture()
  const err = capture()
  const code = await main(['ingest', '--out', join(tmpdir(), 'qare-ingest-nowhere')], out.writer, err.writer)
  expect(code).toBe(4)
  expect(err.text()).toContain('qare ingest requires --sources <manifest.json>')
  const noPlanner = capture()
  const noPlannerErr = capture()
  const withoutPlanner = await main(
    ['ingest', '--sources', 'sources.json', '--out', join(tmpdir(), 'qare-ingest-nowhere')],
    noPlanner.writer,
    noPlannerErr.writer,
  )
  expect(withoutPlanner).toBe(4)
  expect(noPlannerErr.text()).toContain('--nare')
})

test('a manifest with a malformed source is refused by name', async () => {
  const nare = await fakeNare(PLAN)
  const work = await mkdtemp(join(tmpdir(), 'qare-ingest-'))
  const manifestPath = join(work, 'sources.json')
  await writeFile(
    manifestPath,
    `${JSON.stringify({ sources: [{ kind: 'milestone', number: 1, author: 'a', link: 'l', body: 'b' }] })}\n`,
  )
  const out = capture()
  const err = capture()
  const code = await main(
    ['ingest', '--sources', manifestPath, '--out', join(work, 'out'), '--ledger', join(work, 'ledger'), '--nare', nare],
    out.writer,
    err.writer,
  )
  expect(code).toBe(4)
  expect(err.text()).toContain('sources[0].kind must be "issue" or "pr"')
})
