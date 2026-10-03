// Package the example into a desktop build (#72): the Electron runtime with
// the application beside it, under its own name, which is what a packaging
// tool produces and what a profile's client.executable names. The runtime is
// the pinned `electron` release, fetched by its own installer and held to the
// checksums the package ships.
//
//   pnpm install --ignore-workspace --frozen-lockfile && node package.mjs
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
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

const out = join(here, 'dist', 'qare-example')
await rm(out, { recursive: true, force: true })
await mkdir(join(here, 'dist'), { recursive: true })
await cp(join(electron, 'dist'), out, { recursive: true, verbatimSymlinks: true })
await rename(join(out, 'electron'), join(out, 'qare-example'))
// The runtime's default application gives way to this one.
await rm(join(out, 'resources', 'default_app.asar'), { force: true })
await cp(join(here, 'app'), join(out, 'resources', 'app'), { recursive: true })
console.log(join(out, 'qare-example'))
