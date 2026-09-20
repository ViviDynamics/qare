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

console.log(`version ${version} -> ${touched.join(', ')}`)
