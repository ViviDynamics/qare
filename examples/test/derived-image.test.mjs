// The image extension contract (#92): the contract document, the worked
// example and the release guard hold together, and the example builds and runs
// against a base that satisfies the contract. The published base images are
// #88's deliverable, so the docker half builds the contract-conformant fixture
// in the example's test directory, the same build the release guard runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const EXAMPLE = join(ROOT, 'examples', 'derived-image')

function sh(cmd, args, options = {}) {
  return execFileSync(cmd, args, { ...options }).toString()
}

test('the contract document names the stable paths, the user and the tags', async () => {
  const doc = await readFile(join(ROOT, 'docs', 'images.md'), 'utf8')
  for (const path of ['/opt/qare/bin', '/opt/qare/config', '/opt/qare/cache', '/opt/qare/drivers', '/opt/qare/tools', '/work']) {
    assert.match(doc, new RegExp(`\`${path}\``), `missing contract path ${path}`)
  }
  assert.match(doc, /qare.*1000/, 'the qare user is documented with uid and gid 1000')
  assert.match(doc, /ghcr\.io\/vividynamics\/qare-core/, 'the published base images are named')
  assert.match(doc, /`latest`/, 'the release-line and latest tags are documented')
})

test('the README links the contract', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /\[docs\/images\.md\]\(docs\/images\.md\)/, 'the README must link docs/images.md')
})

test('the example builds FROM an overridable base and never runs as root', async () => {
  const dockerfile = await readFile(join(EXAMPLE, 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /^ARG QARE_IMAGE=/m, 'the base is an ARG, so a build pins it')
  assert.match(dockerfile, /^FROM \$QARE_IMAGE$/m, 'the image builds FROM the overridable base')
  assert.match(dockerfile, /ghcr\.io\/vividynamics\/qare-core:latest/, 'the default is the latest tag, overridable through the ARG')
  assert.match(dockerfile, /COPY .+\/opt\/qare\/drivers\//, 'the driver lands on the contract path')
  assert.match(dockerfile, /COPY .+\/opt\/qare\/tools\//, 'the host tool lands on the contract path')
  const userLines = dockerfile.match(/^USER .+$/gm) ?? []
  assert.equal(userLines.length, 1, 'one USER line, so the image has one user')
  assert.equal(userLines[0].trim(), 'USER qare', 'the image runs as the qare user')
})

test('the release workflow builds the example on every release', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(workflow, /derived-image:/, 'a derived-image job exists')
  assert.match(workflow, /needs: \[derived-image\]/, 'the release publishes only after the guard passes')
  assert.match(workflow, /--build-arg QARE_IMAGE=/, 'the example builds through the contract ARG')
  assert.match(workflow, /base-fixture\.Dockerfile/, 'the base is the contract fixture')
  assert.match(workflow, / qare --version/, 'the smoke check runs the entry point on PATH')
  assert.match(workflow, /docker pull ghcr\.io\/vividynamics\/qare-core/, 'the published base is exercised on releases where it exists')
})

test('the example builds against a contract-conformant base and runs as the qare user', async () => {
  // The fixture ships with its version: a fresh checkout builds it whole, and
  // the release guard stamps the file with the release version before its own
  // build.
  const version = (await readFile(join(EXAMPLE, 'test', 'VERSION'), 'utf8')).trim()
  sh('docker', [
    'build', '-f', join(EXAMPLE, 'test', 'base-fixture.Dockerfile'),
    '-t', `qare-contract-base:${version}`, join(EXAMPLE, 'test'),
  ])
  sh('docker', [
    'build', '--build-arg', `QARE_IMAGE=qare-contract-base:${version}`,
    '-t', 'qare-derived:contract-test', '.',
  ], { cwd: EXAMPLE })
  assert.equal(
    sh('docker', ['run', '--rm', 'qare-derived:contract-test', '/opt/qare/bin/qare', '--version']).trim(),
    version,
    'the entry point answers with the stamped version',
  )
  assert.equal(
    sh('docker', ['run', '--rm', 'qare-derived:contract-test', '/opt/qare/drivers/scale-driver/probe']).trim(),
    'scale-driver: ready',
    'the driver runs',
  )
  assert.match(
    sh('docker', ['run', '--rm', 'qare-derived:contract-test', '/opt/qare/tools/measure']),
    /^measure: /,
    'the host tool runs',
  )
  assert.equal(
    sh('docker', ['run', '--rm', 'qare-derived:contract-test', 'qare', '--version']).trim(),
    version,
    'the entry point answers on PATH, not just at its absolute path',
  )
  assert.equal(
    sh('docker', ['run', '--rm', 'qare-derived:contract-test', 'id', '-un']).trim(),
    'qare',
    'the container runs as the qare user, not root',
  )
  assert.equal(
    sh('docker', ['run', '--rm', 'qare-derived:contract-test', 'id', '-u']).trim(),
    '1000',
    'the qare user has uid 1000, as the contract fixes',
  )
  assert.equal(
    sh('docker', ['run', '--rm', 'qare-derived:contract-test', 'id', '-g']).trim(),
    '1000',
    'the qare user has gid 1000, as the contract fixes',
  )
})
