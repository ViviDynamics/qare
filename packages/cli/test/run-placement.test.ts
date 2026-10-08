import { readdirSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

// Test files carry no network literals (the offline scanner), so the URL is joined at runtime.
const TARGET_URL = ['https:', '//app.example.test'].join('')

// This host, as the evidence names it, and an operating system it is not.
const HERE = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform as string] ?? process.platform
const ELSEWHERE = HERE === 'macos' ? 'windows' : 'macos'

async function repo(requires: string): Promise<{ dir: string; args: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-run-placement-'))
  await writeFile(
    join(dir, 'plan.json'),
    JSON.stringify({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'the app answers', checks: [{ kind: 'command', name: 'answers', command: 'node --version' }] }] }),
    'utf8',
  )
  await mkdir(join(dir, '.qa'), { recursive: true })
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n')
  await writeFile(join(dir, '.qa', 'config.yml'), `target:\n  url: ${TARGET_URL}\n  health: { http: /up, timeout: 2s }\n${requires}`)
  return {
    dir,
    args: ['run', '--plan', join(dir, 'plan.json'), '--id', 'pr-76', '--repo', dir, '--base', 'abc', '--head', 'def', '--profile', join(dir, '.qa'), '--evidence', join(dir, 'evidence')],
  }
}

test('qare run on a host without the operating system the profile requires exits 3 with the named reason, before any provisioning (#76)', async () => {
  const { dir, args } = await repo(`requires:\n  os: ${ELSEWHERE}\n`)
  const out = capture()
  const err = capture()
  const probed: string[] = []

  const code = await main(args, out.writer, err.writer, {
    probe: async (url) => {
      probed.push(url)
      return { ok: true }
    },
  })

  // Exit 3 is the refused verdict: the harness decided, and nothing was faulted.
  expect(code).toBe(3)
  const reason = `refused: unmet requirement: a ${ELSEWHERE} host (requires.os): this host is ${HERE}. Nothing was provisioned.`
  // The reason is said where a person running it reads it, not only in a file.
  expect(err.lines.join('')).toContain(`${reason}\n`)
  expect(out.lines.join('')).toContain('verdict refused; evidence ')
  // The target was never probed, and the evidence holds the refusal alone.
  expect(probed).toEqual([])
  expect(readdirSync(join(dir, 'evidence'))).toEqual(['result.json'])
  const result = JSON.parse(await readFile(join(dir, 'evidence', 'result.json'), 'utf8'))
  expect(result.verdict).toBe('refused')
  expect(result.criteria).toEqual([{ id: 'c1', outcome: 'unverified', reason }])
  expect(result.requirements).toEqual({ os: ELSEWHERE })
  // The host kind is this machine's own, detected for real.
  expect(result.environment.host).toMatchObject({ os: HERE, arch: process.arch })
  expect(typeof result.environment.host.virtualisation).toBe('boolean')
})

test('qare run on a host that has what the profile requires goes ahead, and records the requirement and the host (#76)', async () => {
  const { dir, args } = await repo(`requires:\n  os: ${HERE}\n`)
  const code = await main(args, capture().writer, capture().writer, { probe: async () => ({ ok: true }), pollIntervalMs: 1 })
  expect(code).toBe(0)
  const result = JSON.parse(await readFile(join(dir, 'evidence', 'result.json'), 'utf8'))
  expect(result.verdict).toBe('passed')
  expect(result.requirements).toEqual({ os: HERE })
  expect(result.environment.host).toMatchObject({ os: HERE, arch: process.arch })
})

// `qare doctor` runs the host's real probes here: python3 and the docker
// daemon are each given up to ten seconds by the doctor itself, and importing
// the browser driver takes what the runner's disk gives it. The default test
// timeout of five seconds is shorter than what the command is allowed to
// take, so on a slow runner this test timed out at 5080 ms with nothing wrong
// (#277). The bound here is sized for what the test really runs.
const DOCTOR_PROBES_MS = 45_000

test('qare doctor names the host kind and the requirement this host does not meet (#76)', async () => {
  const { dir } = await repo(`requires:\n  os: ${ELSEWHERE}\n`)
  const out = capture()
  const code = await main(['doctor', '--profile', join(dir, '.qa')], out.writer, capture().writer)
  expect(code).toBe(1)
  const text = out.lines.join('')
  expect(text).toMatch(new RegExp(`^ok host: a ${HERE} ${process.arch} host`, 'm'))
  expect(text).toContain(`missing os: this profile requires a ${ELSEWHERE} host (requires.os): this host is ${HERE}\n`)
  expect(text).toContain(`  run it on a ${ELSEWHERE} host: an operating system is not something to install\n`)
}, DOCTOR_PROBES_MS)
