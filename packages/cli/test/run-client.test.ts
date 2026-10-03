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

async function clientRepo(criteria: unknown[]): Promise<{ dir: string; args: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-run-client-'))
  await writeFile(join(dir, 'plan.json'), JSON.stringify({ schemaVersion: '1', criteria }), 'utf8')
  await mkdir(join(dir, '.qa'), { recursive: true })
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n')
  await writeFile(join(dir, '.qa', 'config.yml'), 'client:\n  driver: electron\n  executable: dist/app/app\n')
  return {
    dir,
    args: ['run', '--plan', join(dir, 'plan.json'), '--id', 'pr-1', '--repo', dir, '--base', 'abc', '--head', 'def', '--profile', join(dir, '.qa'), '--evidence', join(dir, 'evidence')],
  }
}

test('qare run --plan holds the plan to the driver the profile\'s client names, when the plan loads (#72)', async () => {
  const { args } = await clientRepo([{ id: 'c1', text: 'the page looks right', checks: [{ kind: 'visual', name: 'home', screenshot: 'home', url: '/' }] }])
  const err = capture()

  const code = await main(args, capture().writer, err.writer, {})

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('a visual check is not one the electron driver declares, so the plan cannot run against it')
})

test('qare run --plan against a client profile whose build is not there is blocked, naming the path (#72)', async () => {
  const { dir, args } = await clientRepo([
    { id: 'c1', text: 'the application greets', checks: [{ kind: 'flow', name: 'greets', actions: [{ action: 'open', url: '/' }, { action: 'assertText', text: 'Greeter' }] }] },
  ])
  const out = capture()

  const code = await main(args, out.writer, capture().writer, {})

  // Exit 2 is the blocked verdict: the harness ran and decided.
  expect(code).toBe(2)
  const result = JSON.parse(await readFile(join(dir, 'evidence', 'result.json'), 'utf8'))
  expect(result.verdict).toBe('blocked')
  expect(result.client).toEqual({ driver: 'electron', executable: 'dist/app/app', comparison: 'none' })
  expect(result.criteria[0].reason).toContain(`resolves to ${join(dir, 'dist', 'app', 'app')}, which is not a file`)
})
