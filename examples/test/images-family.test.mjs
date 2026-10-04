// The shipped image family (#88, #89): the recipes, the size budget and the
// pipeline's image lanes hold together. The docker half builds the family and
// checks that every derived flavour reinstalls nothing
// (images/check-derived.sh); these tests pin the parts the recipes and the
// workflows must keep saying.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

test('the core image recipe builds the workspace, stamps the pinned versions and runs as qare', async () => {
  const dockerfile = await readFile(join(ROOT, 'images', 'core', 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /pnpm install --frozen-lockfile/, 'the workspace builds with the lockfile, so a build is reproducible')
  assert.match(dockerfile, /^ARG NARE_WHEEL=https:\/\/github\.com\/ViviDynamics\/nare\/releases\/download\/2026\.10\.4\/nare-2026\.10\.4-py3-none-any\.whl$/m, 'the shared runtime pins nare 2026.10.4')
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

test('the android flavour builds FROM the overridable core and adds only the emulator family', async () => {
  const dockerfile = await readFile(join(ROOT, 'images', 'android', 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /^ARG QARE_IMAGE=/m, 'the base is an ARG, so a build pins it')
  assert.match(dockerfile, /^FROM \$QARE_IMAGE$/m, 'the android flavour builds FROM the core image')
  assert.match(dockerfile, /^ARG CMDLINE_TOOLS_VERSION=/m, 'the sdk tools are pinned')
  assert.match(dockerfile, /^ARG ANDROID_SYSTEM_IMAGE=/m, 'the system image is pinned')
  assert.match(dockerfile, /DRIVER\.json/, 'the flavour stamps its driver versions beside its drivers')
  assert.match(dockerfile, /QARE_FLAVOUR=android/, 'the flavour names itself')
  assert.match(dockerfile, /drivers\/android\/check/, 'the flavour ships its preboot check')
  assert.match(dockerfile, /images\/android\/check/, 'the check is part of the recipe, not written at build time')
})

test('the android preboot check refuses before booting, naming the requirement', async () => {
  const check = await readFile(join(ROOT, 'images', 'android', 'check'), 'utf8')
  assert.match(check, /\/dev\/kvm/, 'the requirement the host must provide is named')
  assert.match(check, /refusing before boot/, 'the refusal says it happens before anything boots')
  assert.match(check, /exit 1/, 'the check fails the run when a requirement is missing')
})

test('the desktop-linux flavour builds FROM the overridable core and adds the accessibility tree', async () => {
  const dockerfile = await readFile(join(ROOT, 'images', 'desktop-linux', 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /^ARG QARE_IMAGE=/m, 'the base is an ARG, so a build pins it')
  assert.match(dockerfile, /^FROM \$QARE_IMAGE$/m, 'the desktop-linux flavour builds FROM the core image')
  assert.match(dockerfile, /^ARG ATSPI_VERSION=/m, 'the tree bridge is pinned')
  assert.match(dockerfile, /DRIVER\.json/, 'the flavour stamps its driver versions beside its drivers')
  assert.match(dockerfile, /QARE_FLAVOUR=desktop-linux/, 'the flavour names itself')
  assert.match(dockerfile, /xvfb/, 'the desktop-linux flavour installs a virtual display')
  assert.match(dockerfile, /at-spi2-core/, 'the desktop-linux flavour installs the tree bridge')
})

test('the CI workflow builds the images, holds the size budget and checks the derived image', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(workflow, /images\/core\/Dockerfile/, 'CI builds the core image')
  assert.match(workflow, /images\/core\/size-budget/, 'CI holds the core image to its size budget')
  assert.match(workflow, /images\/android\/Dockerfile --build-arg QARE_IMAGE=qare-core:ci/, 'CI builds the android flavour from the CI core')
  assert.match(workflow, /images\/desktop-linux\/Dockerfile --build-arg QARE_IMAGE=qare-core:ci/, 'CI builds the desktop-linux flavour from the CI core')
  assert.match(workflow, /images\/check-derived\.sh qare-core:ci qare-web:ci qare-android:ci qare-desktop-linux:ci/, 'CI checks that every derived image reinstalls nothing')
})

test('the release workflow publishes the family, the android flavour for amd64 only', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(workflow, /  images:/, 'an images job exists')
  assert.match(workflow, /ghcr\.io\/vividynamics\/qare-core:\$\{\{ github\.ref_name \}\}/, 'the core image publishes under the release tag')
  assert.match(workflow, /ghcr\.io\/vividynamics\/qare-web:\$\{\{ github\.ref_name \}\}/, 'the web flavour publishes under the release tag')
  assert.match(workflow, /ghcr\.io\/vividynamics\/qare-android:\$\{\{ github\.ref_name \}\}/, 'the android flavour publishes under the release tag')
  assert.match(workflow, /ghcr\.io\/vividynamics\/qare-desktop-linux:\$\{\{ github\.ref_name \}\}/, 'the desktop-linux flavour publishes under the release tag')
  const platforms = workflow.match(/linux\/amd64,linux\/arm64/g) ?? []
  assert.ok(platforms.length >= 2, 'the core and its client flavours build for both architectures')
  assert.match(workflow, /platforms: linux\/amd64$/m, 'the android flavour builds for amd64 only: its system image is an x86_64 build')
  assert.match(workflow, /QARE_IMAGE=ghcr\.io\/vividynamics\/qare-core:/, 'the flavours build FROM the published core')
  assert.match(workflow, /needs: \[images\]/, 'the guards build against the published family')
  assert.match(workflow, /needs: \[derived-image, android-check\]/, 'the release publishes only after both guards pass')
})

test('the release workflow runs the android preboot check both ways', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(workflow, /android-check:/, 'an android-check job exists')
  assert.match(workflow, /--device \/dev\/kvm/, 'the check runs on a runner with hardware virtualisation')
  assert.match(workflow, /\/opt\/qare\/drivers\/android\/check/, 'the check that runs is the one the published image ships')
  const guard = workflow.split('\n  android-check:')[1]
  const without = guard.split('--user 0')[1]
  assert.ok(without, 'the check also runs without the device mapped')
  assert.match(without, /it must refuse before booting/, 'the run without virtualisation must refuse')
  assert.match(without, /name \/dev\/kvm/, 'the refusal must name the requirement it misses')
})

test('the pipeline pulls the image family instead of building qare from source', async () => {
  // The jobs live in the reusable pipeline (#145); qare.yml only calls it.
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'pipeline.yml'), 'utf8')
  assert.match(workflow, /ghcr\.io\/vividynamics\/qare-core:\$QARE_VERSION/, 'plan and judge pull the core image for the version they run')
  assert.match(workflow, /FLAVOUR: \$\{\{ steps\.flavour\.outputs\.flavour \}\}/, 'execute reads the flavour the profile targets')
  assert.match(workflow, /ghcr\.io\/vividynamics\/qare-\$FLAVOUR:\$QARE_VERSION/, 'execute pulls the flavour the profile targets')
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
