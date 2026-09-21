import { execSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  BranchLedgerStore,
  FileLedgerStore,
  LEDGER_SCHEMA_VERSION,
  LEDGER_STATUSES,
  parseLedgerEntries,
  serializeLedger,
  type LedgerEntry,
} from '../src/ledger.js'

const link = (host: string, path: string) => ['https:' + '', `//${host}${path}`].join('')

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    criterion: 'spec-up-200',
    status: 'active',
    source: [link('example.test', '/pr/1')],
    proof: 'command',
    ...overrides,
  }
}

describe('ledger schema', () => {
  test('parse and serialize round-trip is stable and order-insensitive', () => {
    const entries = [
      entry({ criterion: 'b-criterion', note: 'note b' }),
      entry({ criterion: 'a-criterion', status: 'proposed', note: 'note a' }),
    ]
    const shuffled = serializeLedger([entries[1], entries[0]])
    expect(shuffled).toBe(serializeLedger(entries))
    expect(parseLedgerEntries(JSON.parse(shuffled))).toEqual(entries.sort((x, y) => x.criterion.localeCompare(y.criterion)))
  })

  test('serialized text is canonical json with a trailing newline', () => {
    const text = serializeLedger([entry()])
    expect(LEDGER_SCHEMA_VERSION).toBe('1')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual([{ criterion: 'spec-up-200', status: 'active', source: [link('example.test', '/pr/1')], proof: 'command' }])
  })

  test('strict loader rejects named failures', () => {
    expect(() => parseLedgerEntries({})).toThrow(/must be a JSON array/)
    expect(() => parseLedgerEntries([entry({ status: 'archived' as never })])).toThrow(/unknown status "archived"/)
    expect(() =>
      parseLedgerEntries([{ ...entry(), extra: 1 }]),
    ).toThrow(/unknown field in ledger entry/)
    expect(() => parseLedgerEntries([entry({ criterion: 'a:b' })])).toThrow(/contains ":"/)
    expect(() => parseLedgerEntries([entry({ criterion: '../escape' })])).toThrow(/path separators/)
    expect(() =>
      parseLedgerEntries([entry({ source: [link('ok.test', '/x\nbad')] })]),
    ).toThrow(/newlines/)
    expect(() => parseLedgerEntries([entry({ note: 'multi\nline' })])).toThrow(/note must not contain newlines/)
    expect(() => parseLedgerEntries([{ criterion: '', status: 'active', source: [], proof: 'none' }])).toThrow()
  })

  test('round-trips all four statuses (fixtures per status)', () => {
    const all = LEDGER_STATUSES.map((status, index) =>
      entry({ criterion: `criterion-${index}`, status }),
    )
    expect(parseLedgerEntries(JSON.parse(serializeLedger(all)))).toEqual(all)
  })
})

describe('FileLedgerStore', () => {
  test('round-trips entries through a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-file-'))
    const store = new FileLedgerStore(dir)
    await store.save([entry({ criterion: 'flow-login' }), entry({ criterion: 'visual-home', note: 'n' })])
    expect(await store.load()).toEqual([entry({ criterion: 'flow-login' }), entry({ criterion: 'visual-home', note: 'n' })])
    await rm(dir, { recursive: true })
  })

  test('missing file loads as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-file-'))
    expect(await new FileLedgerStore(dir).load()).toEqual([])
    await rm(dir, { recursive: true })
  })
})

describe('BranchLedgerStore', () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })


  async function realRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-git-'))
    dirs.push(dir)
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email t@e.st', { cwd: dir })
    execSync('git config user.name t', { cwd: dir })
    return dir
  }

  test('round-trips entries through a git branch', async () => {
    const repo = await realRepo()
    const store = new BranchLedgerStore(repo, 'qare-ledger')
    const first = [entry({ criterion: 'egress-refusal', status: 'proposed' })]
    await store.save(first)
    await store.save([entry({ criterion: 'egress-refusal', status: 'active', note: 'verified' })])
    expect(await store.load()).toEqual([entry({ criterion: 'egress-refusal', status: 'active', note: 'verified' })])
    const history = execSync('git log --format=%s --all', { cwd: repo }).toString().trim().split('\n')
    expect(history).toEqual(['criteria ledger update', 'criteria ledger update'])
  })

  test('missing branch loads as empty', async () => {
    const repo = await realRepo()
    expect(await new BranchLedgerStore(repo, 'absent-branch').load()).toEqual([])
  })

  test('injected runner records plumbing commands; argv arrays only', async () => {
    const commands: string[][] = []
    const store = new BranchLedgerStore('/does-not-exist', 'qare-ledger', {
      run: async (args) => {
        commands.push(args)
        if (args[0] === 'hash-object') return { stdout: 'beef\n' }
        if (args[0] === 'mktree') return { stdout: 'cafe\n' }
        if (args[0] === 'rev-parse' && args[1] === '--verify') return { stdout: '1111\n' }
        if (args[0] === 'commit-tree') return { stdout: '2222\n' }
        return { stdout: '' }
      },
    })
    await store.save([entry()])
    expect(commands.map((args) => args[0])).toEqual(['hash-object', 'mktree', 'rev-parse', 'commit-tree', 'update-ref'])
    expect(commands[1]).toEqual(['mktree'])
    expect(commands[2]).toEqual(['rev-parse', '--verify', 'refs/heads/qare-ledger'])
    expect(commands[3]).toEqual(['commit-tree', 'cafe', '-p', '1111', '-m', 'criteria ledger update'])
    expect(commands[4]).toEqual(['update-ref', 'refs/heads/qare-ledger', '2222'])
  })
})
