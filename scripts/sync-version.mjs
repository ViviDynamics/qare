import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CALVER = /^20\d{2}\.\d+\.\d+$/

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const requested = process.argv[2]

function readVersion(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, 'utf8')).version
}

function writeVersion(manifestPath, version) {
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (pkg.version === version) {
    return false
  }
  pkg.version = version
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`)
  return true
}

const rootManifest = join(rootDir, 'package.json')
const version = requested ?? readVersion(rootManifest)

if (!CALVER.test(version)) {
  console.error(`error: ${version} is not a CalVer version (expected YYYY.M.PATCH, e.g. 2026.9.0)`)
  process.exit(1)
}

const touched = []

if (requested !== undefined && writeVersion(rootManifest, version)) {
  touched.push('package.json')
}

const versionSource = join(rootDir, 'packages', 'core', 'src', 'version.ts')
writeFileSync(versionSource, `export const VERSION = '${version}'\n`)
touched.push('packages/core/src/version.ts')

for (const name of readdirSync(join(rootDir, 'packages'))) {
  const manifestPath = join(rootDir, 'packages', name, 'package.json')
  if (writeVersion(manifestPath, version)) {
    touched.push(join('packages', name, 'package.json'))
  }
}

// The reusable pipeline pins the release it ships in (#145): a called
// workflow cannot learn its own ref, so the release is written into the file
// as the default of `qare-ref`, and into the caller the documentation shows.
// A pin that is not found is an error, never a silent skip: a release whose
// pipeline names another release's qare is the drift the pin exists to stop.
function stamp(relativePath, pattern, what) {
  const path = join(rootDir, relativePath)
  const before = readFileSync(path, 'utf8')
  if (!pattern.test(before)) {
    console.error(`error: ${relativePath} carries no ${what} to stamp with ${version}`)
    process.exit(1)
  }
  const after = before.replace(pattern, (_match, head, tail) => `${head}${version}${tail}`)
  if (after !== before) {
    writeFileSync(path, after)
    touched.push(relativePath)
  }
}

stamp('.github/workflows/pipeline.yml', /(\n {6}qare-ref:\n(?: {8}.*\n)*? {8}default: ')[^']*(')/, 'qare-ref default')
stamp('docs/pipeline.md', /(\.github\/workflows\/pipeline\.yml@)20\d{2}\.\d+\.\d+()/g, 'pinned caller')

console.log(`version ${version} -> ${touched.join(', ')}`)
