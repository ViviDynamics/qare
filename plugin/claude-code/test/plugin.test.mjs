import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK = join(PLUGIN_ROOT, 'hooks', 'stop.mjs')

function frontmatterOf(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown)
  assert.ok(match, 'document must open with a --- frontmatter block')
  return match[1]
}

function fieldOf(frontmatter, field) {
  const match = new RegExp(`^${field}: (.*)$`, 'm').exec(frontmatter)
  assert.ok(match, `frontmatter must carry ${field}`)
  return match[1].trim()
}

test('plugin manifest parses and names the plugin', async () => {
  const manifest = JSON.parse(await readFile(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(manifest.name, 'qare')
  assert.equal(typeof manifest.version, 'string')
  assert.ok(manifest.version.trim() !== '')
  assert.equal(typeof manifest.description, 'string')
  assert.ok(manifest.description.trim() !== '')
})

test('skill exists with required frontmatter', async () => {
  const markdown = await readFile(join(PLUGIN_ROOT, 'skills', 'qare', 'SKILL.md'), 'utf8')
  const frontmatter = frontmatterOf(markdown)
  assert.equal(fieldOf(frontmatter, 'name'), 'qare')
  const description = fieldOf(frontmatter, 'description')
  assert.ok(description.trim() !== '')
  assert.ok(markdown.includes('result.json'))
  assert.ok(markdown.includes('qare run'))
})

test('verifier subagent is read-only and downgrade-only', async () => {
  const markdown = await readFile(join(PLUGIN_ROOT, 'agents', 'qare-verifier.md'), 'utf8')
  const frontmatter = frontmatterOf(markdown)
  assert.equal(fieldOf(frontmatter, 'name'), 'qare-verifier')
  const tools = fieldOf(frontmatter, 'tools').split(',').map((entry) => entry.trim())
  assert.deepEqual(tools, ['Read', 'Grep', 'Glob'])
  assert.ok(markdown.includes('never upgrade'), 'framing must forbid upgrades')
  assert.ok(markdown.includes('downgrade'), 'framing must name the downgrade path')
  assert.ok(markdown.includes('You never introduce a verdict'), 'framing must forbid new verdicts')
})

test('hooks.json wires Stop to an existing script', async () => {
  const wiring = JSON.parse(await readFile(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'))
  const stop = wiring.hooks.Stop
  assert.ok(Array.isArray(stop) && stop.length > 0)
  for (const entry of stop) {
    for (const hook of entry.hooks ?? []) {
      assert.equal(hook.type, 'command')
      assert.match(hook.command, /stop\.mjs/)
      const script = hook.command.match(/hooks\/stop\.mjs/)
      assert.ok(script, 'command must reference the stop script')
    }
  }
  assert.ok(existsSync(HOOK), 'stop script must exist')
})

const RESULT_FIXTURES = {
  passed: {
    schemaVersion: '1',
    verdict: 'passed',
    criteria: [{ id: 'login-works', outcome: 'proven', evidence: ['shots/login.png'] }],
    job: { id: 'job-1' },
  },
  failed: {
    schemaVersion: '1',
    verdict: 'failed',
    criteria: [{ id: 'login-works', outcome: 'failed', evidence: ['shots/login.png'] }],
    job: { id: 'job-1' },
  },
  blocked: { schemaVersion: '1', verdict: 'blocked', criteria: [] },
  refused: { schemaVersion: '1', verdict: 'refused', criteria: [] },
  waived: {
    schemaVersion: '1',
    verdict: 'waived',
    criteria: [{ id: 'login-works', outcome: 'unverified', reason: 'waived by @maintainer' }],
    waived: [{ criterionId: 'login-works', by: '@maintainer' }],
  },
}

async function withTempResults() {
  const dir = await mkdtemp(join(tmpdir(), 'qare-hook-'))
  for (const [name, value] of Object.entries(RESULT_FIXTURES)) {
    await writeFile(join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }
  return dir
}

function runHook(...args) {
  return spawnSync(process.execPath, [HOOK, ...args], { encoding: 'utf8', cwd: PLUGIN_ROOT })
}

test('hook exits 0 only for a passed verdict', async () => {
  const dir = await withTempResults()
  try {
    const passed = runHook(join(dir, 'passed.json'))
    assert.equal(passed.status, 0, `stderr: ${passed.stderr}`)
    assert.match(passed.stdout, /QARE_PASS: qare verdict passed \(job job-1\)/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hook blocks with distinct named messages per verdict', async () => {
  const dir = await withTempResults()
  try {
    const expectations = new Map([
      ['failed', /QARE_FAILED: qare verdict failed: criteria not proven login-works/],
      ['blocked', /QARE_BLOCKED: qare verdict blocked/],
      ['refused', /QARE_REFUSED: qare verdict refused/],
      ['waived', /QARE_WAIVED: qare verdict waived: a human waiver is recorded/],
    ])
    const messages = []
    for (const [name, pattern] of expectations) {
      const outcome = runHook(join(dir, `${name}.json`))
      assert.equal(outcome.status, 1, `${name} must exit 1; stderr: ${outcome.stderr}`)
      assert.match(outcome.stderr, pattern)
      messages.push(outcome.stderr)
    }
    assert.equal(new Set(messages).size, messages.length, 'each verdict names a distinct message')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hook fails closed with named errors for missing or malformed results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-hook-'))
  try {
    const missing = runHook(join(dir, 'nope.json'))
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /QARE_RESULT_MISSING/)

    const broken = join(dir, 'broken.json')
    await writeFile(broken, '{"verdict": ', 'utf8')
    const invalid = runHook(broken)
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /QARE_RESULT_INVALID_JSON/)

    await writeFile(broken, '{"schemaVersion":"1","verdict":"passed","criteria":[]}', 'utf8')
    assert.match(runHook(broken).stderr, /QARE_RESULT_INVALID/)

    const fakePass = '{"schemaVersion":"1","verdict":"passed","criteria":[{"id":"c1","outcome":"unverified","reason":"thin air"}]}'
    await writeFile(broken, fakePass, 'utf8')
    assert.match(runHook(broken).stderr, /QARE_RESULT_INVALID/)

    const shapeCases = [
      ['QARE_RESULT_SCHEMA_VERSION', '{"schemaVersion":"9","verdict":"passed","criteria":[]}'],
      ['QARE_RESULT_VERDICT', '{"schemaVersion":"1","verdict":"green","criteria":[]}'],
      ['QARE_RESULT_CRITERIA', '{"schemaVersion":"1","verdict":"passed"}'],
      ['QARE_RESULT_CRITERIA', '{"schemaVersion":"1","verdict":"blocked","criteria":[{"id":"c1","outcome":"green"}]}'],
    ]
    for (const [name, body] of shapeCases) {
      await writeFile(broken, body, 'utf8')
      const outcome = runHook(broken)
      assert.equal(outcome.status, 1, body)
      assert.match(outcome.stderr, new RegExp(name))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hook takes the result path from stdin JSON or QARE_RESULT_PATH', async () => {
  const dir = await withTempResults()
  try {
    const viaStdin = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: 's1', result_path: join(dir, 'passed.json') }),
      encoding: 'utf8',
      cwd: PLUGIN_ROOT,
    })
    assert.equal(viaStdin.status, 0, `stderr: ${viaStdin.stderr}`)
    assert.match(viaStdin.stdout, /QARE_PASS/)

    const viaEnv = spawnSync(process.execPath, [HOOK], {
      env: { ...process.env, QARE_RESULT_PATH: join(dir, 'failed.json') },
      input: JSON.stringify({ session_id: 's1' }),
      encoding: 'utf8',
      cwd: PLUGIN_ROOT,
    })
    assert.equal(viaEnv.status, 1)
    assert.match(viaEnv.stderr, /QARE_FAILED/)

    const defaults = spawnSync(process.execPath, [HOOK], {
      input: '{}',
      encoding: 'utf8',
      cwd: dir,
    })
    assert.equal(defaults.status, 1)
    assert.match(defaults.stderr, /QARE_RESULT_MISSING/)
    assert.match(defaults.stderr, /\.qare.result\.json/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
