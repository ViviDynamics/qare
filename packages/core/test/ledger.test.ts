import { execSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  BranchLedgerStore,
  FileLedgerStore,
  LEDGER_SCHEMA_VERSION,
  LEDGER_STATUSES,
  LEDGER_FILE,
  parseLedgerEntries,
  serializeLedger,
  type LedgerEntry,
} from '../src/ledger.js'

const link = (host: string, path: string) => ['https:', `//${host}${path}`].join('')

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    criterion: 'spec-up-200',
    status: 'active',
    source: [link('example.test', '/pr/1')],
    proof: 'command',
    ...overrides,
  }
}

function doc(entries: LedgerEntry[] | unknown, schemaVersion = LEDGER_SCHEMA_VERSION) {
  return { entries, schemaVersion }
}

describe('ledger schema', () => {
  test('parse and serialize round-trip is stable and order-insensitive', () => {
    const entries = [
      entry({ criterion: 'b-criterion', note: 'note b' }),
      entry({ criterion: 'a-criterion', status: 'proposed', note: 'note a' }),
    ]
    const shuffled = serializeLedger([entries[1], entries[0]])
    expect(shuffled).toBe(serializeLedger(entries))
    expect(parseLedgerEntries(JSON.parse(shuffled))).toEqual([entries[1], entries[0]])
  })

  test('serialized form is a versioned canonical document', () => {
    const text = serializeLedger([entry()])
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(doc([entry()]))
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: '1' })
  })

  test('strict loader rejects named failures', () => {
    expect(() => parseLedgerEntries([])).toThrow(/must be a JSON object with a "entries" array/)
    expect(() => parseLedgerEntries(doc([], '2'))).toThrow(
      /unsupported ledger schema version "2" \(expected "1"\)/,
    )
    expect(() => parseLedgerEntries({ entries: [] })).toThrow(/unsupported ledger schema version undefined/)
    expect(() => parseLedgerEntries({ entries: [], schemaVersion: '1', extra: 1 })).toThrow(
      /unknown field in ledger document/,
    )
    expect(() => parseLedgerEntries(doc([entry({ status: 'archived' as never })]))).toThrow(
      /unknown status "archived"/,
    )
    expect(() => parseLedgerEntries(doc([{ ...entry(), extra: 1 }]))).toThrow(
      /unknown field in ledger entry/,
    )
    expect(() => parseLedgerEntries(doc([entry({ criterion: 'a:b' })]))).toThrow(/contains ":"/)
    expect(() => parseLedgerEntries(doc([entry({ criterion: '../escape' })]))).toThrow(/path separators/)
    expect(() =>
      parseLedgerEntries(doc([entry({ source: [link('ok.test', '/x\nbad')] })])),
    ).toThrow(/source link must not contain newlines/)
    expect(() => parseLedgerEntries(doc([entry({ note: 'multi\nline' })]))).toThrow(
      /note must not contain newlines/,
    )
    expect(() =>
      parseLedgerEntries(doc([{ criterion: '', status: 'active', source: [], proof: 'none' }])),
    ).toThrow(/criterion id must be a non-empty string/)
  })

  test('duplicate criteria in one document fail closed', () => {
    expect(() => parseLedgerEntries(doc([entry(), entry({ status: 'proposed' })]))).toThrow(
      /duplicate criterion "spec-up-200"/,
    )
  })

  test('round-trips all four statuses (fixtures per status)', () => {
    const all = LEDGER_STATUSES.map((status, index) => entry({ criterion: `criterion-${index}`, status }))
    expect(parseLedgerEntries(JSON.parse(serializeLedger(all)))).toEqual(all)
  })
})

describe('FileLedgerStore', () => {
  test('round-trips entries through a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-file-'))
    const store = new FileLedgerStore(dir)
    await store.save([entry({ criterion: 'flow-login' }), entry({ criterion: 'visual-home', note: 'n' })])
    expect(await store.load()).toEqual([
      entry({ criterion: 'flow-login' }),
      entry({ criterion: 'visual-home', note: 'n' }),
    ])
    await rm(dir, { recursive: true })
  })

  test('missing file loads as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-file-'))
    expect(await new FileLedgerStore(dir).load()).toEqual([])
    await rm(dir, { recursive: true })
  })

  test('corrupt and unsupported files fail closed instead of loading empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-file-'))
    const file = join(dir, 'ledger.json')
    await writeFile(file, '{"entries":')
    await expect(new FileLedgerStore(dir).load()).rejects.toThrow()
    await writeFile(file, '{"entries":[],"schemaVersion":"9"}')
    await expect(new FileLedgerStore(dir).load()).rejects.toThrow(/unsupported ledger schema version "9"/)
    await rm(dir, { recursive: true })
  })

  test('save rejects entries the loader would refuse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-file-'))
    const store = new FileLedgerStore(dir)
    await expect(store.save([entry({ note: '' })])).rejects.toThrow(/note must be a non-empty string/)
    await expect(store.save([entry({ status: 'Active' as never })])).rejects.toThrow(/unknown status "Active"/)
    await expect(store.save([entry(), entry({ status: 'proposed' })])).rejects.toThrow(
      /duplicate criterion "spec-up-200"/,
    )
    expect(await store.load()).toEqual([])
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

  test('round-trips entries through a git branch with parented history', async () => {
    const repo = await realRepo()
    const store = new BranchLedgerStore(repo, 'qare-ledger')
    await store.save([entry({ criterion: 'egress-refusal', status: 'proposed' })])
    await store.save([entry({ criterion: 'egress-refusal', status: 'active', note: 'verified' })])
    expect(await store.load()).toEqual([
      entry({ criterion: 'egress-refusal', status: 'active', note: 'verified' }),
    ])
    const parents = execSync('git rev-list --parents -n 1 refs/heads/qare-ledger', { cwd: repo }).toString().trim().split(' ')
    expect(parents).toHaveLength(2)
    const history = execSync('git log --format=%s refs/heads/qare-ledger', { cwd: repo }).toString().trim().split('\n')
    expect(history).toEqual(['criteria ledger update', 'criteria ledger update'])
  })

  test('missing branch loads as empty', async () => {
    const repo = await realRepo()
    expect(await new BranchLedgerStore(repo, 'absent-branch').load()).toEqual([])
  })

  test('branch present but ledger unreadable fails closed', async () => {
    const repo = await realRepo()
    const seed = execSync('git commit-tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904 -m seed', { cwd: repo }).toString().trim()
    execSync(`git update-ref refs/heads/qare-ledger ${seed}`, { cwd: repo })
    const store = new BranchLedgerStore(repo, 'qare-ledger')
    await expect(store.load()).rejects.toThrow(/unreadable/)
  })

  test('injected runner records plumbing commands; mktree input pinned', async () => {
    const commands: string[][] = []
    const inputs: (string | undefined)[] = []
    const store = new BranchLedgerStore('/does-not-exist', 'qare-ledger', {
      run: async (args, input) => {
        commands.push(args)
        inputs.push(input)
        if (args[0] === 'hash-object') return { stdout: 'beef\n' }
        if (args[0] === 'mktree') return { stdout: 'cafe\n' }
        if (args[0] === 'rev-parse' && args[1] === '--verify') return { stdout: '1111\n' }
        if (args[0] === 'commit-tree') return { stdout: '2222\n' }
        return { stdout: '' }
      },
    })
    await store.save([entry()])
    expect(commands.map((args) => args[0])).toEqual(['hash-object', 'mktree', 'rev-parse', 'commit-tree', 'update-ref'])
    expect(inputs[1]).toBe(`100644 blob beef\t${LEDGER_FILE}`)
    expect(inputs[0]).toBe(serializeLedger([entry()]))
    expect(commands[2]).toEqual(['rev-parse', '--verify', 'refs/heads/qare-ledger'])
    expect(commands[3]).toEqual(['commit-tree', 'cafe', '-p', '1111', '-m', 'criteria ledger update'])
    expect(commands[4]).toEqual(['update-ref', 'refs/heads/qare-ledger', '2222'])
  })
})
