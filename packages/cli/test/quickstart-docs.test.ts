import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { INIT_DEFAULT_MODEL, INIT_MODEL_SECRET } from '@qare/core'

// #375: a new repository's way in is one page, and it runs the released CLI
// from an image the release workflow actually publishes. These tests hold the
// quickstart, the README and the SPEC to the code they describe, so a rename
// of the image or a new init default cannot leave the first page wrong.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8')
const QUICKSTART = 'docs/quickstart.md'

test('the quickstart runs the CLI from an image the release publishes, mounting the repository at the image workdir', () => {
  expect(existsSync(join(repoRoot, QUICKSTART)), `${QUICKSTART} is missing`).toBe(true)
  const doc = read(QUICKSTART)
  const release = read('.github/workflows/release.yml')
  const image = /QARE=(ghcr\.io\/vividynamics\/qare-[a-z-]+):<release>/.exec(doc)?.[1]
  expect(image, 'the quickstart names no released image').toBeDefined()
  expect(release).toContain(`${image}:\${{ github.ref_name }}`)
  // The contract's working directory and entry point (docs/images.md).
  expect(read('images/core/Dockerfile')).toMatch(/^WORKDIR \/work$/m)
  expect(doc).toContain('docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" "$QARE" qare init')
})

test("the quickstart states init's default model and the secret command it prints", () => {
  const doc = read(QUICKSTART)
  expect(doc).toContain(`\`${INIT_DEFAULT_MODEL}\``)
  expect(doc).toContain(`gh secret set ${INIT_MODEL_SECRET}`)
})

test('the quickstart stays one page', () => {
  expect(read(QUICKSTART).split('\n').length).toBeLessThanOrEqual(100)
})

test('the README links the quickstart before any other doc and no longer says design', () => {
  const readme = read('README.md')
  const firstDocLink = /\]\((docs\/[^)]+)\)/.exec(readme)?.[1]
  expect(firstDocLink).toBe(QUICKSTART)
  expect(readme).not.toMatch(/Status: design/)
})

test("the SPEC names nare's providers and init's default instead of Claude only", () => {
  const spec = read('docs/SPEC.md')
  expect(spec).not.toMatch(/Claude only|Models other than Claude/)
  for (const provider of ['anthropic', 'bedrock', 'openai']) expect(spec).toContain(`\`${provider}\``)
  expect(spec).toContain(`\`${INIT_DEFAULT_MODEL}\``)
  expect(spec).toContain(`\`${INIT_MODEL_SECRET}\``)
})
