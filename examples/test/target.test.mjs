// A run against a target qare did not boot (#122), end to end through the CLI:
// a local HTTP server stands in for the deployed site, so the test needs no
// network. The flow half drives a real chromium when one is installed, and
// otherwise must come back unverified, never failed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url))

const ARTICLE = '<!doctype html><html><head><title>Ada Lovelace</title></head><body><h1>Ada Lovelace</h1><p>First programmer.</p></body></html>'

async function site() {
  const server = createServer((req, res) => {
    // Like Wikipedia, the site refuses an anonymous client: the probe must name itself.
    if (req.url === '/health') return res.writeHead(/^qare\//.test(req.headers['user-agent'] ?? '') ? 200 : 403).end()
    if (req.url === '/wiki/Ada_Lovelace') return res.writeHead(200, { 'content-type': 'text/html' }).end(ARTICLE)
    res.writeHead(404).end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

async function repo(targetUrl) {
  const dir = await mkdtemp(join(tmpdir(), 'qare-target-e2e-'))
  await mkdir(join(dir, '.qa'))
  // The whole profile: QA.md and a target. No fixtures, no stubs, no compose.
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n')
  await writeFile(join(dir, '.qa', 'config.yml'), `target:\n  url: ${targetUrl}\n  health: { http: /health, timeout: 3s }\n`)
  await writeFile(
    join(dir, 'page-has.mjs'),
    [
      'const [url, text] = process.argv.slice(2)',
      'const response = await globalThis.fetch(url)',
      'const body = await response.text()',
      'console.log(response.status, body.includes(text) ? "found" : "missing")',
      'process.exit(response.ok && body.includes(text) ? 0 : 1)',
    ].join('\n'),
  )
  return dir
}

function jobFor(dir) {
  return {
    id: 'target-e2e',
    repoPath: dir,
    baseRef: 'main',
    headRef: 'HEAD',
    profile: { path: '.qa' },
    evidenceDir: join(dir, 'evidence'),
    post: 'none',
    criteria: [
      {
        id: 'served',
        text: 'The Ada Lovelace article is served',
        checks: [{ kind: 'command', run: 'node page-has.mjs {{run.target_url}}/wiki/Ada_Lovelace Ada', timeoutMs: 10000 }],
      },
      {
        id: 'shown',
        text: 'The Ada Lovelace article shows its title',
        checks: [
          {
            kind: 'flow',
            timeoutMs: 30000,
            actions: [
              { action: 'open', url: '/wiki/Ada_Lovelace' },
              { action: 'assert', text: 'First programmer.' },
            ],
          },
        ],
      },
    ],
  }
}

// Async, not spawnSync: the local site has to answer while the CLI runs.
function runCli(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'run', '--job', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(jobFor(dir)))
  })
}

test('a profile holding only a target and QA.md runs command and flow checks against that URL', async (t) => {
  const { server, url } = await site()
  const dir = await repo(url)
  t.after(async () => {
    server.close()
    await rm(dir, { recursive: true, force: true })
  })

  const outcome = await runCli(dir)
  const result = JSON.parse(await readFile(join(dir, 'evidence', 'result.json'), 'utf8'))
  assert.notEqual(outcome.code, 4, outcome.stderr)

  assert.deepEqual(result.target, { url, comparison: 'none' })
  const [served, shown] = result.criteria
  assert.equal(served.outcome, 'proven', JSON.stringify(result))
  assert.match(await readFile(join(dir, 'evidence', 'checks', 'served', '0', 'stdout.txt'), 'utf8'), /200 found/)
  // With a browser the flow proves its criterion; without one it is unverified.
  // It is never failed, and never proven by anything but the page.
  if (shown.outcome === 'proven') {
    assert.equal(result.verdict, 'passed')
    const outbound = JSON.parse(await readFile(join(dir, 'evidence', 'checks', 'shown', '0', 'outbound.json'), 'utf8'))
    assert.ok(outbound.reached.length > 0 && outbound.reached.every((entry) => entry.declared), JSON.stringify(outbound))
  } else {
    assert.equal(shown.outcome, 'unverified', JSON.stringify(shown))
    assert.match(shown.reason, /backend|browser|Executable|executable/)
  }
})

test('a target that is down is blocked, naming the URL, and no criterion is failed', async (t) => {
  const { server, url } = await site()
  await new Promise((resolve) => server.close(resolve))
  const dir = await repo(url)
  t.after(() => rm(dir, { recursive: true, force: true }))

  const outcome = await runCli(dir)
  // Exit 2 is the blocked verdict: the harness ran and decided.
  assert.equal(outcome.code, 2, outcome.stderr)
  const result = JSON.parse(await readFile(join(dir, 'evidence', 'result.json'), 'utf8'))

  assert.equal(result.verdict, 'blocked')
  for (const criterion of result.criteria) {
    assert.equal(criterion.outcome, 'unverified')
    assert.ok(criterion.reason.includes(url), criterion.reason)
  }
})
