import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { provisionClient, type ArtefactInstaller, type ClientHealthCheck, type ProfileClient, type ProvisionOpts } from '../src/index.js'

const UP: ClientHealthCheck = async () => ({ ok: true, lines: ['[main stdout] ready', '[window 1 opened] file:///app/index.html'] })

function client(artefact: Partial<NonNullable<ProfileClient['artefact']>> = {}, extra: Partial<ProfileClient> = {}): ProfileClient {
  return {
    driver: 'electron',
    args: ['--no-sandbox'],
    artefact: { kind: 'archive', executable: 'greeter/greeter', head: { path: 'artefacts/head.tar.gz' }, ...artefact },
    ...extra,
  }
}

/** A repository with a build of the greeter beside it, unpacked and as an archive. */
async function workspace(): Promise<{ root: string; installRoot: string; opts: ProvisionOpts }> {
  const root = await mkdtemp(join(tmpdir(), 'qare-provision-'))
  const installRoot = await mkdtemp(join(tmpdir(), 'qare-provision-installs-'))
  await mkdir(join(root, 'build', 'greeter'), { recursive: true })
  await writeFile(join(root, 'build', 'greeter', 'greeter'), '#!/bin/sh\nexit 0\n')
  await chmod(join(root, 'build', 'greeter', 'greeter'), 0o755)
  await mkdir(join(root, 'artefacts'))
  execFileSync('tar', ['-czf', join(root, 'artefacts', 'head.tar.gz'), '-C', join(root, 'build'), 'greeter'])
  return { root, installRoot, opts: { root, installRoot, health: UP } }
}

test('a prebuilt archive is installed into a directory of the run\'s own, proven up, and removed again (#75)', async () => {
  const { root, installRoot, opts } = await workspace()
  const asked: Array<{ executable: string; args: readonly string[]; timeoutMs: number }> = []
  const outcome = await provisionClient(client({}, { health: { timeout: '20s' } }), {
    ...opts,
    health: async (input) => {
      asked.push(input)
      // The build is installed when the harness asks whether it is up.
      expect(existsSync(input.executable)).toBe(true)
      return UP(input)
    },
  })
  if (outcome.kind !== 'up') throw new Error(outcome.reason)

  // Installed outside the checkout, under the root the run names for installs.
  expect(outcome.executable.startsWith(installRoot)).toBe(true)
  expect(outcome.executable.endsWith(join('greeter', 'greeter'))).toBe(true)
  expect(outcome.executable.startsWith(root)).toBe(false)
  expect(asked).toEqual([{ executable: outcome.executable, args: ['--no-sandbox'], timeoutMs: 20_000 }])
  expect(outcome.artefact).toMatchObject({ side: 'head', path: 'artefacts/head.tar.gz', kind: 'archive', source: 'prebuilt' })
  expect(outcome.artefact.sha256).toMatch(/^[0-9a-f]{64}$/)

  const teardown = await outcome.teardown()
  expect(teardown).toEqual({ ok: true })
  // Nothing is left behind, and the artefact itself is the project's, untouched.
  expect(readdirSync(installRoot)).toEqual([])
  expect(existsSync(join(root, 'artefacts', 'head.tar.gz'))).toBe(true)

  const log = outcome.log()
  expect(log).toContain('provisioning the head side from artefacts/head.tar.gz (archive)')
  expect(log).toMatch(/\[obtain\] artefacts\/head\.tar\.gz is there: \d+ bytes, sha256 [0-9a-f]{64}/)
  expect(log).toContain('[install] tar -xf')
  expect(log).toContain('[health] [window 1 opened] file:///app/index.html')
  expect(log).toContain('[health] the build came up')
  expect(log).toMatch(/\[teardown\] removed .*; nothing is left/)
  // A second teardown is a no-op: the run may tear down on more than one path.
  expect(await outcome.teardown()).toEqual({ ok: true })
})

test('an artefact that is not there blocks, naming the artefact, and nothing is installed or launched (#75)', async () => {
  const { installRoot, opts } = await workspace()
  let launched = false
  const outcome = await provisionClient(client({ head: { path: 'artefacts/missing.tar.gz' } }), {
    ...opts,
    health: async (input) => {
      launched = true
      return UP(input)
    },
  })
  expect(outcome.kind).toBe('blocked')
  if (outcome.kind !== 'blocked') return
  expect(outcome.reason).toMatch(/^the head artefact artefacts\/missing\.tar\.gz is not there to install: it resolves to .*missing\.tar\.gz, which does not exist/)
  expect(outcome.reason).toContain('client.artefact.head.build')
  expect(launched).toBe(false)
  expect(readdirSync(installRoot)).toEqual([])
  expect(outcome.log()).toContain('[blocked] the head artefact artefacts/missing.tar.gz is not there to install')
})

test('a side whose artefact is missing is built by the command the profile declares, in the tree of its side (#75)', async () => {
  const { root, opts } = await workspace()
  const baseTree = await mkdtemp(join(tmpdir(), 'qare-provision-base-tree-'))
  const ran: Array<{ command: string; args: string[]; cwd: string; artefact?: string; side?: string }> = []
  const outcome = await provisionClient(
    client({ head: { path: 'artefacts/head.tar.gz' }, base: { path: 'artefacts/base.tar.gz', build: 'node scripts/package.mjs --archive' } }),
    {
      ...opts,
      side: 'base',
      buildRoot: baseTree,
      runCommand: async (command, args, run) => {
        if (command === 'tar') return { code: Number(execFileSync('sh', ['-c', `tar ${args.map((arg) => `'${arg}'`).join(' ')} >/dev/null 2>&1; echo $?`]).toString().trim()), output: '' }
        ran.push({ command, args, cwd: run.cwd, artefact: run.env.QARE_ARTEFACT, side: run.env.QARE_SIDE })
        execFileSync('cp', [join(root, 'artefacts', 'head.tar.gz'), join(root, 'artefacts', 'base.tar.gz')])
        return { code: 0, output: 'packaged\n' }
      },
    },
  )
  if (outcome.kind !== 'up') throw new Error(outcome.reason)
  expect(ran).toEqual([{ command: 'node', args: ['scripts/package.mjs', '--archive'], cwd: baseTree, artefact: join(root, 'artefacts', 'base.tar.gz'), side: 'base' }])
  expect(outcome.artefact).toMatchObject({ side: 'base', path: 'artefacts/base.tar.gz', source: 'built' })
  expect(outcome.log()).toContain('[build] packaged')
  await outcome.teardown()
})

test('an artefact that is already there is never rebuilt (#75)', async () => {
  const { opts } = await workspace()
  const built: string[] = []
  const outcome = await provisionClient(client({ head: { path: 'artefacts/head.tar.gz', build: 'make head' } }), {
    ...opts,
    runCommand: async (command, args) => {
      if (command !== 'tar') built.push(command)
      return { code: Number(execFileSync('sh', ['-c', `${command} ${args.map((arg) => `'${arg}'`).join(' ')} >/dev/null 2>&1; echo $?`]).toString().trim()), output: '' }
    },
  })
  if (outcome.kind !== 'up') throw new Error(outcome.reason)
  expect(built).toEqual([])
  expect(outcome.artefact.source).toBe('prebuilt')
  await outcome.teardown()
})

test('a build that fails blocks naming the artefact and the command, with its output in the log (#75)', async () => {
  const { installRoot, opts } = await workspace()
  const outcome = await provisionClient(client({ head: { path: 'artefacts/other.tar.gz', build: 'make other' } }), {
    ...opts,
    runCommand: async () => ({ code: 2, output: 'make: *** No rule to make target other.\n' }),
  })
  expect(outcome.kind).toBe('blocked')
  if (outcome.kind !== 'blocked') return
  expect(outcome.reason).toBe('the head artefact artefacts/other.tar.gz could not be built: `make other` exited 2')
  expect(outcome.log()).toContain('[build] make: *** No rule to make target other.')
  expect(readdirSync(installRoot)).toEqual([])
})

test('an install that fails blocks naming the artefact, keeps the installer\'s output, and leaves nothing behind (#75)', async () => {
  const { root, installRoot, opts } = await workspace()
  await writeFile(join(root, 'artefacts', 'corrupt.tar.gz'), 'this is not an archive\n')
  const outcome = await provisionClient(client({ head: { path: 'artefacts/corrupt.tar.gz' } }), opts)
  expect(outcome.kind).toBe('blocked')
  if (outcome.kind !== 'blocked') return
  expect(outcome.reason).toMatch(/^the head artefact artefacts\/corrupt\.tar\.gz could not be installed: tar exited \d+/)
  expect(outcome.log()).toMatch(/\[install\] tar: /)
  expect(outcome.artefact).toMatchObject({ path: 'artefacts/corrupt.tar.gz', source: 'prebuilt' })
  expect(readdirSync(installRoot)).toEqual([])
})

test('an installed artefact that carries no such executable blocks, and the install is removed (#75)', async () => {
  const { installRoot, opts } = await workspace()
  const outcome = await provisionClient(client({ executable: 'greeter/other' }), opts)
  expect(outcome.kind).toBe('blocked')
  if (outcome.kind !== 'blocked') return
  expect(outcome.reason).toBe('the head artefact artefacts/head.tar.gz could not be installed: it carries no executable at greeter/other (client.artefact.executable)')
  expect(readdirSync(installRoot)).toEqual([])
})

test('a build that does not come up blocks naming the artefact, with what it wrote, and is uninstalled (#75)', async () => {
  const { installRoot, opts } = await workspace()
  const outcome = await provisionClient(client(), {
    ...opts,
    health: async () => ({ ok: false, reason: 'the application exited with code 1 before it opened a window', lines: ['[main stderr] cannot open display'] }),
  })
  expect(outcome.kind).toBe('blocked')
  if (outcome.kind !== 'blocked') return
  expect(outcome.reason).toBe(
    'the head artefact artefacts/head.tar.gz was installed, but the build did not come up within 30s: the application exited with code 1 before it opened a window',
  )
  expect(outcome.log()).toContain('[health] [main stderr] cannot open display')
  expect(outcome.log()).toMatch(/\[teardown\] removed .*; nothing is left/)
  expect(readdirSync(installRoot)).toEqual([])
})

test('an unpacked directory is installed as a copy, so the project\'s own build is never the one that runs or is removed (#75)', async () => {
  const { root, installRoot, opts } = await workspace()
  const outcome = await provisionClient(client({ kind: 'directory', head: { path: 'build' } }), opts)
  if (outcome.kind !== 'up') throw new Error(outcome.reason)
  expect(outcome.executable.startsWith(installRoot)).toBe(true)
  expect(await readFile(outcome.executable, 'utf8')).toBe('#!/bin/sh\nexit 0\n')
  // A directory has no one hash to name.
  expect(outcome.artefact.sha256).toBeUndefined()
  await outcome.teardown()
  expect(readdirSync(installRoot)).toEqual([])
  expect(existsSync(join(root, 'build', 'greeter', 'greeter'))).toBe(true)
  // The kind is what the profile says: an archive named as a directory is not installed.
  const wrong = await provisionClient(client({ kind: 'directory' }), opts)
  expect(wrong.kind === 'blocked' && wrong.reason).toBe('the head artefact artefacts/head.tar.gz could not be installed: client.artefact.kind says directory, and it is a file')
})

test('an artefact that resolves outside the repository is never installed (#75)', async () => {
  const { root, installRoot, opts } = await workspace()
  const elsewhere = await mkdtemp(join(tmpdir(), 'qare-provision-elsewhere-'))
  execFileSync('cp', [join(root, 'artefacts', 'head.tar.gz'), join(elsewhere, 'other.tar.gz')])
  await symlink(join(elsewhere, 'other.tar.gz'), join(root, 'artefacts', 'linked.tar.gz'))
  const outcome = await provisionClient(client({ head: { path: 'artefacts/linked.tar.gz' } }), opts)
  expect(outcome.kind).toBe('blocked')
  if (outcome.kind !== 'blocked') return
  expect(outcome.reason).toMatch(/^the head artefact artefacts\/linked\.tar\.gz resolves outside the repository the run checks/)
  expect(readdirSync(installRoot)).toEqual([])
})

test('the base side is named as the base in every reason (#75)', async () => {
  const { opts } = await workspace()
  const outcome = await provisionClient(client({ base: { path: 'artefacts/base.tar.gz' } }), { ...opts, side: 'base' })
  expect(outcome.kind === 'blocked' && outcome.reason).toMatch(/^the base artefact artefacts\/base\.tar\.gz is not there to install/)
})

test('a host that cannot show a window blocks before anything is installed (#75)', async () => {
  const { installRoot, opts } = await workspace()
  const outcome = await provisionClient(client(), { ...opts, host: { env: {}, platform: 'linux', xvfb: () => undefined } })
  expect(outcome.kind === 'blocked' && outcome.reason).toMatch(/the electron driver needs a display/)
  expect(readdirSync(installRoot)).toEqual([])
})

test('a device installer plugs in behind the same seam: install, launch target, uninstall (#75, for #73 and #74)', async () => {
  const { root, opts } = await workspace()
  await writeFile(join(root, 'artefacts', 'app.apk'), 'not a real package\n')
  const device: string[] = []
  const installer: ArtefactInstaller = {
    install: async (input) => {
      device.push(`install ${input.artefact} for ${input.side}`)
      input.log('Performing Streamed Install')
      return {
        ok: true,
        installed: {
          location: 'emulator-5554',
          // What a device driver launches is an application id, not a path.
          executable: input.executable,
          uninstall: async () => {
            device.push(`uninstall ${input.executable}`)
          },
        },
      }
    },
  }
  const outcome = await provisionClient(client({ kind: 'package', executable: 'com.example.greeter', head: { path: 'artefacts/app.apk' } }), {
    ...opts,
    installers: { package: installer },
    health: async (input) => {
      device.push(`health ${input.executable}`)
      return { ok: true, lines: [] }
    },
  })
  if (outcome.kind !== 'up') throw new Error(outcome.reason)
  expect(outcome.executable).toBe('com.example.greeter')
  expect(outcome.log()).toContain('[install] Performing Streamed Install')
  expect(await outcome.teardown()).toEqual({ ok: true })
  expect(device).toEqual([`install ${join(root, 'artefacts', 'app.apk')} for head`, 'health com.example.greeter', 'uninstall com.example.greeter'])
})

test('an uninstall that fails is reported, never swallowed: state left behind is named (#75)', async () => {
  const { root, opts } = await workspace()
  await writeFile(join(root, 'artefacts', 'app.apk'), 'not a real package\n')
  const installer: ArtefactInstaller = {
    install: async (input) => ({
      ok: true,
      installed: {
        location: 'emulator-5554',
        executable: input.executable,
        uninstall: async () => {
          throw new Error('device offline')
        },
      },
    }),
  }
  const outcome = await provisionClient(client({ kind: 'package', executable: 'com.example.greeter', head: { path: 'artefacts/app.apk' } }), { ...opts, installers: { package: installer } })
  if (outcome.kind !== 'up') throw new Error(outcome.reason)
  expect(await outcome.teardown()).toEqual({ ok: false, reason: 'the head artefact artefacts/app.apk could not be uninstalled from emulator-5554: device offline' })
  expect(outcome.log()).toContain('[teardown] the head artefact artefacts/app.apk could not be uninstalled from emulator-5554: device offline')
})

test('an artefact kind nothing installs blocks by name (#75)', async () => {
  const { opts } = await workspace()
  const outcome = await provisionClient(client({ kind: 'package' }), opts)
  expect(outcome.kind === 'blocked' && outcome.reason).toBe('the head artefact artefacts/head.tar.gz could not be installed: no installer is registered for the artefact kind "package"')
})
