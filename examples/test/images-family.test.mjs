// The shipped image family (#88): the recipes, the size budget and the
// pipeline's image lanes hold together. The docker half builds both flavours
// and checks that the derived one reinstalls nothing (images/check-derived.sh);
// these tests pin the parts the recipes and the workflows must keep saying.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

test('the core image recipe builds the workspace, stamps the pinned versions and runs as qare', async () => {
  const dockerfile = await readFile(join(ROOT, 'images', 'core', 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /pnpm install --frozen-lockfile/, 'the workspace builds with the lockfile, so a build is reproducible')
  assert.match(dockerfile, /NARE_WHEEL=/, 'the nare wheel is pinned')
  assert.match(dockerfile, /useradd --uid 1000/, 'the qare user is the contract user')
  assert.match(dockerfile, /QARE_CONTAINER=1/, 'the image marks its runs containerised')
  assert.match(dockerfile, /\/opt\/qare\/config\/IMAGE\.json/, 'the image stamps its own record')
  assert.doesNotMatch(dockerfile, /playwright|chromium/i, 'the core image ships no client driver')
})

test('the core image holds its size budget', async () => {
  const budget = Number((await readFile(join(ROOT, 'images', 'core', 'size-budget'), 'utf8')).trim())
  assert.ok(Number.isFinite(budget) && budget > 0, 'the budget is a positive byte count')
  assert.ok(budget < 500_000_000, 'the budget keeps the base the smallest thing that runs qare')
})

test('the web flavour builds FROM the overridable core and adds only the driver family', async () => {
  const dockerfile = await readFile(join(ROOT, 'images', 'web', 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /^ARG QARE_IMAGE=/m, 'the base is an ARG, so a build pins it')
  assert.match(dockerfile, /^FROM \$QARE_IMAGE$/m, 'the web flavour builds FROM the core image')
  assert.match(dockerfile, /DRIVER\.json/, 'the flavour stamps its driver versions beside its drivers')
  assert.match(dockerfile, /QARE_FLAVOUR=web/, 'the flavour names itself')
  assert.match(dockerfile, /xvfb/, 'the web flavour installs a virtual display')
})

test('the CI workflow builds the images, holds the size budget and checks the derived image', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(workflow, /images\/core\/Dockerfile/, 'CI builds the core image')
  assert.match(workflow, /images\/core\/size-budget/, 'CI holds the core image to its size budget')
  assert.match(workflow, /images\/check-derived\.sh/, 'CI checks that the derived image reinstalls nothing')
})

test('the release workflow publishes the family for amd64 and arm64', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(workflow, /  images:/, 'an images job exists')
  assert.match(workflow, /ghcr\.io\/vividynamics\/qare-core:\$\{\{ github\.ref_name \}\}/, 'the core image publishes under the release tag')
  assert.match(workflow, /ghcr\.io\/vividynamics\/qare-web:\$\{\{ github\.ref_name \}\}/, 'the web flavour publishes under the release tag')
  const platforms = workflow.match(/linux\/amd64,linux\/arm64/g) ?? []
  assert.ok(platforms.length >= 2, 'both images build for both architectures')
  assert.match(workflow, /QARE_IMAGE=ghcr\.io\/vividynamics\/qare-core:/, 'the web flavour builds FROM the published core')
  assert.match(workflow, /needs: \[images\]/, 'the contract guard builds against the published family')
})

test('the pipeline pulls the image family instead of building qare from source', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'qare.yml'), 'utf8')
  assert.match(workflow, /ghcr\.io\/vividynamics\/qare-core:\$version/, 'plan and judge pull the core image for the version they run')
  assert.match(workflow, /ghcr\.io\/vividynamics\/qare-\$\{\{ steps\.flavour\.outputs\.flavour \}\}:\$version/, 'execute pulls the flavour the profile targets')
  assert.match(workflow, /QARE_IMAGE_REF/, 'the run names the image ref in its evidence')
  assert.match(workflow, /QARE_IMAGE_DIGEST/, 'the run names the image digest in its evidence')
  const sections = workflow.split('\n  # label: ')
  for (const job of ['plan', 'execute', 'judge']) {
    const section = sections.find((one) => one.startsWith(job))
    assert.ok(section, `the ${job} job exists`)
    assert.doesNotMatch(section, /pnpm install --frozen-lockfile/, `the ${job} job builds no qare from source`)
  }
})

test('the no-reinstall check compares the bytes the base ships', async () => {
  const check = await readFile(join(ROOT, 'images', 'check-derived.sh'), 'utf8')
  assert.match(check, /sha256sum/, 'the check compares file digests, not names')
  assert.match(check, /ARG QARE_IMAGE=/, 'the check holds the web recipe to the contract ARG')
})
