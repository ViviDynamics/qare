// Package the example into a desktop build (#72): the Electron runtime with
// the application beside it, under its own name, which is what a packaging
// tool produces and what a profile's client.executable names. The runtime is
// the pinned `electron` release, fetched by its own installer and held to the
// checksums the package ships.
//
//   pnpm install --ignore-workspace --frozen-lockfile && node package.mjs
//
// With --archive the build is packed into a tar instead (#75), which is what
// a profile's client.artefact names and a run installs. --app takes the
// application from another directory, which is how a build of the base
// revision is made beside the head's: the same runtime, the base's files.
//
//   node package.mjs --archive artefacts/head.tar
//   node package.mjs --archive artefacts/base.tar --app <base checkout>/examples/electron-app/app
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const option = (name) => {
  const at = process.argv.indexOf(name)
  if (at === -1) return undefined
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} takes a path`)
    process.exit(1)
  }
  return value
}
// A profile's build command is told where to write (QARE_ARTEFACT).
const archiveOption = option('--archive') ?? process.env.QARE_ARTEFACT
const archive = archiveOption === undefined ? undefined : resolve(archiveOption)
const app = resolve(option('--app') ?? join(here, 'app'))
if (!existsSync(join(app, 'package.json'))) {
  console.error(`${app} is not an application directory: it holds no package.json`)
  process.exit(1)
}

const electron = join(here, 'node_modules', 'electron')
if (!existsSync(join(electron, 'install.js'))) {
  console.error('the electron package is not installed: run `pnpm install --ignore-workspace --frozen-lockfile` in examples/electron-app first')
  process.exit(1)
}
// The package carries no binary until its installer has run.
if (!existsSync(join(electron, 'dist', 'electron'))) {
  const installed = spawnSync(process.execPath, [join(electron, 'install.js')], { stdio: 'inherit' })
  if (installed.status !== 0) process.exit(installed.status ?? 1)
}

await mkdir(join(here, 'dist'), { recursive: true })
// An archive is packed from a staging directory of its own, so packing a
// build of the base never disturbs the unpacked build beside it.
const stage = archive === undefined ? undefined : await mkdtemp(join(here, 'dist', 'stage-'))
const out = join(stage ?? join(here, 'dist'), 'qare-example')
await rm(out, { recursive: true, force: true })
await cp(join(electron, 'dist'), out, { recursive: true, verbatimSymlinks: true })
await rename(join(out, 'electron'), join(out, 'qare-example'))
// The runtime's default application gives way to this one.
await rm(join(out, 'resources', 'default_app.asar'), { force: true })
await cp(app, join(out, 'resources', 'app'), { recursive: true })
if (archive === undefined) {
  console.log(join(out, 'qare-example'))
} else {
  await mkdir(dirname(archive), { recursive: true })
  const packed = spawnSync('tar', ['-cf', archive, '-C', dirname(out), 'qare-example'], { stdio: 'inherit' })
  await rm(stage, { recursive: true, force: true })
  if (packed.status !== 0) process.exit(packed.status ?? 1)
  console.log(archive)
}
