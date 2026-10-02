import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { loadProfile } from '../src/index.js'

// The run image's real toolset, read off the published 2026.10.1 web image:
// node, grep, test, python3, nare and the image's own qare CLI. npm, git, jq,
// pnpm and vitest are absent from the image, and the executing job installs
// and builds nothing, so a declared command naming any of those could never
// run (#158).
const IMAGE_PROGRAMS = ['node', 'grep', 'test', 'python3', 'nare', 'qare']

const selfProfileDir = fileURLToPath(new URL('../../../.qa', import.meta.url))

test("qare's own profile declares only commands the run image really has", async () => {
  const profile = await loadProfile(selfProfileDir)
  expect(Object.keys(profile.commands ?? {}).length).toBeGreaterThan(0)
  for (const command of Object.values(profile.commands ?? {})) {
    const program = command.run.trim().split(/\s+/)[0]
    expect(IMAGE_PROGRAMS).toContain(program)
  }
})

test("qare's own profile says plainly what a self-run cannot show", async () => {
  const profile = await loadProfile(selfProfileDir)
  const instructions = (profile.instructions ?? '').replace(/\s+/g, ' ')
  expect(instructions).toContain('no test runner')
  expect(instructions).toContain('installs and builds nothing')
})
