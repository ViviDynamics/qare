import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { criterionIdFor, integrityOf, serializeLedger, type LedgerEntry } from '@qare/core'
import { FAKE_TOKEN, startFakeGithub } from './fake-github.js'
import { GitHubClient } from '../src/github.js'
import { deliverIngest } from '../src/ingest-deliver.js'

const link = (host: string, path: string) => ['https:', `//${host}${path}`].join('')

const CARRIED = 'the payouts page shows the 1099 notice for a host paid past the annual threshold'
const NEW = 'ingest never writes the ledger itself'

async function seeded(): Promise<{ fake: Awaited<ReturnType<typeof startFakeGithub>>; ledgerText: string; entries: LedgerEntry[] }> {
  const fake = await startFakeGithub()
  fake.issues.set(37, { number: 37, title: 'ingest', body: '## Acceptance criteria\n\n- [ ] rule\n', comments: [] })
  const entries: LedgerEntry[] = [
    { criterion: criterionIdFor(CARRIED), status: 'active', source: [link('example.test', '/issues/9')], proof: 'command' },
  ]
  const ledgerText = serializeLedger(entries)
  fake.blobs.set('blob-base', Buffer.from(ledgerText))
  fake.trees.set('tree-base', [{ path: '.qa/ledger.json', mode: '100644', type: 'blob', sha: 'blob-base' }])
  fake.commits.set('commit-1', { tree: 'tree-base', parents: [] })
  fake.refs.set('refs/heads/main', 'commit-1')
  return { fake, ledgerText, entries }
}

async function payload(dir: string, entries: LedgerEntry[], resulting: string, comments: boolean) {
  const proposalPath = join(dir, 'ingest-proposal.json')
  await writeFile(
    proposalPath,
    `${JSON.stringify({
      ledgerPath: '.qa/ledger.json',
      baseFingerprint: integrityOf(entries),
      ledgerText: resulting,
      branch: 'qare-ledger-proposal-abcdef12',
      title: 'Propose 1 ledger criteria',
      body: 'Proposes 1 criteria for the criteria ledger.',
    })}\n`,
  )
  const commentsPath = join(dir, 'ingest-comments.json')
  await writeFile(
    commentsPath,
    `${JSON.stringify([
      { issue: 37, marker: `qare-ingest:${criterionIdFor(NEW)}`, body: `@Jason733i the criterion \`${NEW}\` cannot be proposed as written: no check can show it. <!-- qare-ingest:${criterionIdFor(NEW)} -->` },
    ])}\n`,
  )
  return { proposalPath, commentsPath: comments ? commentsPath : undefined }
}

function clientFor(fake: Awaited<ReturnType<typeof startFakeGithub>>): GitHubClient {
  return new GitHubClient({ repository: 'o/r', apiRoot: fake.url, token: FAKE_TOKEN })
}

test('the delivery opens the pull request a human applies and comments once', async () => {
  const { fake, entries } = await seeded()
  const proposal: LedgerEntry = {
    criterion: criterionIdFor(NEW),
    status: 'proposed',
    source: [link('example.test', '/issues/37')],
    proof: 'command',
    note: NEW,
  }
  const work = await mkdtemp(join(tmpdir(), 'qare-deliver-'))
  const paths = await payload(work, entries, serializeLedger([...entries, proposal]), true)
  const delivery = await deliverIngest({ ...paths, base: 'main', client: clientFor(fake) })

  expect(delivery.alreadyProposed).toBe(false)
  expect(delivery.pull.number).toBeGreaterThan(0)
  expect(fake.pulls).toHaveLength(1)
  expect(fake.pulls[0]!.head).toBe('qare-ledger-proposal-abcdef12')
  expect(fake.pulls[0]!.base).toBe('main')
  expect(fake.refs.get('refs/heads/qare-ledger-proposal-abcdef12')).toBeDefined()
  // The base branch itself is never pushed to.
  expect(fake.refs.get('refs/heads/main')).toBe('commit-1')
  expect(fake.issues.get(37)!.comments).toHaveLength(1)
  expect(fake.issues.get(37)!.comments[0]).toContain(`qare-ingest:${criterionIdFor(NEW)}`)
  expect(delivery.postedComments).toEqual([37])

  // The same payload, delivered again, is one proposal and no second comment.
  const again = await deliverIngest({ ...paths, base: 'main', client: clientFor(fake) })
  expect(again.alreadyProposed).toBe(true)
  expect(again.skippedComments).toEqual([37])
  expect(fake.pulls).toHaveLength(1)
  expect(fake.issues.get(37)!.comments).toHaveLength(1)
})

test('a delivery whose base ledger has moved is refused', async () => {
  const { fake, entries } = await seeded()
  fake.blobs.set(
    'blob-base',
    Buffer.from(
      serializeLedger([...entries, { criterion: 'c-moved', status: 'active', source: [link('example.test', '/issues/8')], proof: 'command' }]),
    ),
  )
  const work = await mkdtemp(join(tmpdir(), 'qare-deliver-'))
  const paths = await payload(work, entries, serializeLedger(entries), false)
  await expect(deliverIngest({ ...paths, base: 'main', client: clientFor(fake) })).rejects.toThrow(
    /the ledger on main does not match the one ingest ran against/,
  )
  expect(fake.pulls).toHaveLength(0)
})

test('a repo with no ledger yet is delivered as an empty base', async () => {
  const fake = await startFakeGithub()
  fake.commits.set('commit-1', { tree: 'tree-base', parents: [] })
  fake.trees.set('tree-base', [])
  fake.refs.set('refs/heads/main', 'commit-1')
  const work = await mkdtemp(join(tmpdir(), 'qare-deliver-'))
  const paths = await payload(
    work,
    [],
    serializeLedger([
      { criterion: criterionIdFor(NEW), status: 'proposed', source: [link('example.test', '/issues/37')], proof: 'command', note: NEW },
    ]),
    false,
  )
  const delivery = await deliverIngest({ ...paths, base: 'main', client: clientFor(fake) })
  expect(delivery.pull.number).toBeGreaterThan(0)
  expect(fake.refs.get('refs/heads/qare-ledger-proposal-abcdef12')).toBeDefined()
})
