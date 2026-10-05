import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import { clientCellProblem, reapLiveCells, startClientCell, trackLiveCell, type CellDocker, type CellProcess } from '../src/client-cell.js'

/** A docker that records every call and plays the gate's and the build's containers. */
function fakeDocker(script: { gateLines?: string[]; gateExit?: number; fail?: Record<string, string>; port?: string; address?: string } = {}) {
  const calls: string[][] = []
  const spawned: Array<{ args: string[]; process: FakeProcess }> = []
  class FakeProcess extends EventEmitter implements CellProcess {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    killed: string[] = []
    kill(signal?: NodeJS.Signals): boolean {
      this.killed.push(signal ?? 'SIGTERM')
      return true
    }
  }
  const docker: CellDocker = {
    run: async (args) => {
      calls.push(args)
      const verb = args[0] as string
      const failure = script.fail?.[verb]
      if (failure !== undefined) return { code: 1, stdout: '', stderr: failure }
      if (verb === 'port') return { code: 0, stdout: `${script.port ?? '127.0.0.1:49222'}\n`, stderr: '' }
      if (verb === 'inspect') return { code: 0, stdout: `${script.address ?? '172.17.0.5'}\n`, stderr: '' }
      if (verb === 'stop') {
        // The gate writes its record as it stops.
        const gate = spawned.find((entry) => entry.args.includes('gate'))?.process
        for (const line of script.gateLines ?? [JSON.stringify({ event: 'summary', capped: false, reached: [] })]) gate?.stdout.emit('data', `${line}\n`)
        gate?.emit('close', script.gateExit ?? 0, null)
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    spawn: (args) => {
      const process = new FakeProcess()
      spawned.push({ args, process })
      if (args.includes('gate') && script.fail?.gate === undefined) setImmediate(() => process.stdout.emit('data', '{"event":"ready","relayPort":9222}\n'))
      if (args.includes('gate') && script.fail?.gate !== undefined)
        setImmediate(() => {
          process.stderr.emit('data', script.fail?.gate as string)
          process.emit('close', 125, null)
        })
      return process
    },
    runSync: (args) => {
      calls.push(['sync', ...args])
    },
  }
  return { docker, calls, spawned }
}

const OPTS = {
  image: 'qare-web:test',
  // The directory the build is launched from: where its executable is.
  install: '/work/repo/dist/app',
  hosts: ['api.example.test', '*.cdn.example.test'],
  uid: 1001,
  gid: 118,
  id: 'abc123',
  // The relay answers on the published port, as it does where the daemon is on this machine.
  canConnect: async (host: string) => host === '127.0.0.1',
}

test('a cell is a volume, a gate on the default network, and a build with no network at all (#223)', async () => {
  const { docker, calls, spawned } = fakeDocker()
  const cell = await startClientCell({ ...OPTS, docker })

  // The volume the two share: memory only, and the run's own user's.
  expect(calls[0]).toEqual(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=1m,uid=1001,gid=118,mode=0700', 'qare-cell-abc123'])
  // The gate: no capability, the declared hosts, the relay published on loopback only.
  expect(spawned[0]?.args).toEqual([
    'run', '--rm', '--name', 'qare-cell-abc123-gate',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-u', '1001:118', '-e', 'HOME=/tmp',
    '-v', 'qare-cell-abc123:/run/qare-cell',
    '-p', '127.0.0.1::9222',
    'qare-web:test', 'qare', 'cell', 'gate', '--socket-dir', '/run/qare-cell', '--host', 'api.example.test', '--host', '*.cdn.example.test',
  ])
  expect(calls[1]).toEqual(['port', 'qare-cell-abc123-gate', '9222/tcp'])
  expect(calls[2]).toEqual(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', 'qare-cell-abc123-gate'])

  // The build's directory is copied in: a volume of its own, filled over the
  // daemon's API through a container that never runs. A copy holds no socket
  // and no file made after it was taken, so nothing outside the cell can
  // leave the build a way round the gate in the checkout.
  expect(calls.slice(3)).toEqual([
    ['volume', 'create', 'qare-cell-abc123-build'],
    ['create', '--name', 'qare-cell-abc123-load', '-v', 'qare-cell-abc123-build:/build', 'qare-web:test', 'true'],
    ['cp', '/work/repo/dist/app/.', 'qare-cell-abc123-load:/build'],
    ['rm', '-f', 'qare-cell-abc123-load'],
  ])

  const child = cell.spawn('/work/repo/dist/app/app', ['--no-sandbox', '--remote-debugging-port=9222'])
  // The build: no network, a resolver on its own loopback, no capability, its own directory as a read-only copy, no docker socket.
  // The runner's search domain stays out: with it, every name the build asks for is asked again with the runner's own suffix.
  expect(spawned[1]?.args).toEqual([
    'run', '--rm', '--name', 'qare-cell-abc123-app',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-u', '1001:118', '-e', 'HOME=/tmp',
    '-v', 'qare-cell-abc123:/run/qare-cell',
    '--network', 'none', '--dns', '127.0.0.1', '--dns-search', '.',
    '-v', 'qare-cell-abc123-build:/work/repo/dist/app:ro', '-w', '/work/repo/dist/app',
    'qare-web:test', 'qare', 'cell', 'launch', '--socket-dir', '/run/qare-cell', '--cdp-port', '9222', '--',
    '/work/repo/dist/app/app', '--no-sandbox', '--remote-debugging-port=9222',
  ])
  expect(spawned[1]?.args.join(' ')).not.toContain('docker.sock')
  // Nothing of the machine's own filesystem is mounted into either container: every mount is a volume the cell made.
  for (const { args } of spawned) expect(args.filter((arg, index) => args[index - 1] === '-v' && arg.startsWith('/'))).toEqual([])
  expect(child).toBe(spawned[1]?.process)

  // What the driver is told: the port the build listens on in its cell, a
  // user data directory inside it, and the endpoint as the runner reaches it.
  expect(cell.debuggingPort).toBe(9222)
  expect(cell.userDataDir).toBe('/tmp/qare-electron-abc123')
  expect(cell.endpoint('ws://127.0.0.1:9222/devtools/browser/7f3a')).toBe('ws://127.0.0.1:49222/devtools/browser/7f3a')
  await cell.dispose()
})

test('disposing a cell stops the build, reads the gate\'s record, and removes everything it made (#223)', async () => {
  const reached = [
    { host: 'api.example.test', port: 443, protocol: 'https', declared: true, count: 3 },
    { host: 'evil.example.test', port: 53, protocol: 'dns', declared: false, count: 1 },
  ]
  const { docker, calls } = fakeDocker({ gateLines: ['not json', JSON.stringify({ event: 'summary', capped: false, reached })] })
  const cell = await startClientCell({ ...OPTS, docker })
  // The record is the gate's last word: before the cell is disposed there is none to read.
  expect(() => cell.record()).toThrow(/has not been disposed/)
  await cell.dispose()
  expect(calls.slice(7)).toEqual([
    ['rm', '-f', 'qare-cell-abc123-app'],
    ['stop', '-t', '10', 'qare-cell-abc123-gate'],
    ['rm', '-f', 'qare-cell-abc123-gate'],
    ['volume', 'rm', '-f', 'qare-cell-abc123'],
    ['volume', 'rm', '-f', 'qare-cell-abc123-build'],
  ])
  expect(cell.record()).toEqual({ reached })
  // Twice is once.
  await cell.dispose()
  expect(calls).toHaveLength(12)
})

test('a record that was cut says so, and one that never arrived is not read as empty (#223)', async () => {
  const cut = fakeDocker({ gateLines: [JSON.stringify({ event: 'summary', capped: true, reached: [] })] })
  const capped = await startClientCell({ ...OPTS, docker: cut.docker })
  await capped.dispose()
  expect(capped.record()).toEqual({ reached: [], incomplete: 'the build reached for more distinct destinations than the gate records, so the record was cut' })

  const silent = fakeDocker({ gateLines: [], gateExit: 137 })
  const lost = await startClientCell({ ...OPTS, docker: silent.docker })
  await lost.dispose()
  expect(() => lost.record()).toThrow('the gate stopped (code 137) without writing its record, so what the build reached is not known')

  // A summary that is not the gate's shape is not a record either.
  const odd = fakeDocker({ gateLines: [JSON.stringify({ event: 'summary', reached: [{ host: 7 }] })] })
  const malformed = await startClientCell({ ...OPTS, docker: odd.docker })
  await malformed.dispose()
  expect(() => malformed.record()).toThrow(/without writing its record/)
})

test('a cell that cannot be made is not half made: what was started is removed, and the reason is the daemon\'s (#223)', async () => {
  const noVolume = fakeDocker({ fail: { volume: 'Error response from daemon: tmpfs volumes are not supported' } })
  await expect(startClientCell({ ...OPTS, docker: noVolume.docker })).rejects.toThrow(
    'the cell could not be made: docker volume create failed: Error response from daemon: tmpfs volumes are not supported',
  )
  expect(noVolume.spawned).toHaveLength(0)

  const noGate = fakeDocker({ fail: { gate: 'docker: Error response from daemon: pull access denied for qare-web' } })
  await expect(startClientCell({ ...OPTS, docker: noGate.docker })).rejects.toThrow(
    /the cell could not be made: the gate exited with code 125 before it was ready: docker: Error response from daemon: pull access denied/,
  )
  expect(noGate.calls.slice(-3)).toEqual([['rm', '-f', 'qare-cell-abc123-gate'], ['volume', 'rm', '-f', 'qare-cell-abc123'], ['volume', 'rm', '-f', 'qare-cell-abc123-build']])

  // Neither the published port nor the gate's own address answers: the daemon is not on this machine.
  const elsewhere = fakeDocker()
  await expect(startClientCell({ ...OPTS, docker: elsewhere.docker, canConnect: async () => false })).rejects.toThrow(
    'the cell could not be made: the gate\'s relay for the driver answered at neither 127.0.0.1:49222 nor 172.17.0.5:9222, so the docker daemon is not on the machine the run is on',
  )
  expect(elsewhere.calls.slice(-3)).toEqual([['rm', '-f', 'qare-cell-abc123-gate'], ['volume', 'rm', '-f', 'qare-cell-abc123'], ['volume', 'rm', '-f', 'qare-cell-abc123-build']])
})

test('the driver attaches where the relay answers: the published port, or the gate\'s own address (#223)', async () => {
  // A daemon that publishes on a loopback the run does not share (a desktop
  // daemon in a VM, with the run in a container on its network): the gate's
  // own address on the default bridge is where the run reaches it.
  const tried: string[] = []
  const { docker } = fakeDocker()
  const cell = await startClientCell({
    ...OPTS,
    docker,
    canConnect: async (host, port) => {
      tried.push(`${host}:${port}`)
      return host === '172.17.0.5'
    },
  })
  expect(tried).toEqual(['127.0.0.1:49222', '172.17.0.5:9222'])
  expect(cell.endpoint('ws://127.0.0.1:9222/devtools/browser/7f3a')).toBe('ws://172.17.0.5:9222/devtools/browser/7f3a')
  await cell.dispose()

  // An address that is not one is never dialled.
  const odd = fakeDocker({ address: 'not an address', port: '' })
  await expect(startClientCell({ ...OPTS, docker: odd.docker, canConnect: async () => true })).rejects.toThrow(/the gate's relay for the driver has no address to be reached at/)
})

test('a harness that is going away takes the cell with it, without waiting (#223)', async () => {
  const { docker, calls } = fakeDocker()
  const cell = await startClientCell({ ...OPTS, docker })
  cell.reap()
  expect(calls.slice(7)).toEqual([
    ['sync', 'rm', '-f', 'qare-cell-abc123-app', 'qare-cell-abc123-gate', 'qare-cell-abc123-load'],
    ['sync', 'volume', 'rm', '-f', 'qare-cell-abc123', 'qare-cell-abc123-build'],
  ])
})

test('what a cell needs is checked by name: the image the run is in, and a daemon that has it (#223)', async () => {
  const { docker, calls } = fakeDocker()
  expect(await clientCellProblem({ QARE_IMAGE_REF: 'qare-web:test' }, docker)).toBeUndefined()
  expect(calls).toEqual([['version', '--format', '{{.Server.Version}}'], ['image', 'inspect', '--format', '{{.Id}}', 'qare-web:test']])

  expect(await clientCellProblem({}, docker)).toBe(
    'a contained build or command runs in a cell made from the image the run is in, and QARE_IMAGE_REF names none (the pipeline\'s execute step sets it); a profile that must run uncontained says so: a build with client.egress: uncontained, a command with commands.<name>.egress: uncontained, and the evidence then says it too',
  )
  const noDaemon = fakeDocker({ fail: { version: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\nIs the docker daemon running?' } })
  expect(await clientCellProblem({ QARE_IMAGE_REF: 'qare-web:test' }, noDaemon.docker)).toBe(
    'a contained build or command runs in a cell the docker daemon makes, and no daemon answered (Cannot connect to the Docker daemon at unix:///var/run/docker.sock.); a profile that must run uncontained says so: a build with client.egress: uncontained, a command with commands.<name>.egress: uncontained, and the evidence then says it too',
  )
  const noImage = fakeDocker({ fail: { image: 'Error: No such image: qare-web:test' } })
  expect(await clientCellProblem({ QARE_IMAGE_REF: 'qare-web:test' }, noImage.docker)).toMatch(
    /^a contained build or command runs in a cell made from the image the run is in, and the docker daemon does not have qare-web:test; /,
  )
  // An image reference is handed to docker as an argument, so it is held to being one.
  expect(await clientCellProblem({ QARE_IMAGE_REF: '--privileged' }, docker)).toMatch(/QARE_IMAGE_REF is not an image reference/)
})

test('a signal that ends the harness takes every cell with it, a half made one included (#223)', async () => {
  // A cell whose gate never says it is ready: still being made when the signal arrives.
  const slow = fakeDocker({ fail: { gate: 'never ready' } })
  slow.docker.spawn = (args) => {
    const made = new (class extends EventEmitter {
      stdout = new EventEmitter()
      stderr = new EventEmitter()
      kill(): boolean {
        return true
      }
    })()
    slow.spawned.push({ args, process: made as never })
    return made
  }
  const making = startClientCell({ ...OPTS, docker: slow.docker, id: 'half01', readyTimeoutMs: 200 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const whole = fakeDocker()
  const cell = await startClientCell({ ...OPTS, docker: whole.docker, id: 'whole1' })
  reapLiveCells()
  expect(slow.calls.filter((call) => call[0] === 'sync')).toEqual([
    ['sync', 'rm', '-f', 'qare-cell-half01-app', 'qare-cell-half01-gate', 'qare-cell-half01-load'],
    ['sync', 'volume', 'rm', '-f', 'qare-cell-half01', 'qare-cell-half01-build'],
  ])
  expect(whole.calls.filter((call) => call[0] === 'sync')).toHaveLength(2)
  await expect(making).rejects.toThrow(/the gate was not ready in time/)
  // A cell that was disposed is nobody's to reap any more.
  const done = fakeDocker()
  await (await startClientCell({ ...OPTS, docker: done.docker, id: 'done01' })).dispose()
  reapLiveCells()
  expect(done.calls.filter((call) => call[0] === 'sync')).toEqual([])
  await cell.dispose()
  // A caller's own cell is tracked the same way, and let go when it says so.
  const reaped: string[] = []
  const release = trackLiveCell(() => reaped.push('once'))
  reapLiveCells()
  release()
  reapLiveCells()
  expect(reaped).toEqual(['once'])
})

test('a build the run installed outside the checkout is copied into the cell, not mounted from a path the daemon may not see (#223, #75)', async () => {
  const { docker, calls, spawned } = fakeDocker()
  const install = '/tmp/qare-install-head-x1'
  const cell = await startClientCell({ ...OPTS, docker, install })
  // A volume of its own, filled through a container that never runs: the
  // copy travels over the daemon's API, so it works wherever the daemon is.
  expect(calls.slice(3)).toEqual([
    ['volume', 'create', 'qare-cell-abc123-build'],
    ['create', '--name', 'qare-cell-abc123-load', '-v', 'qare-cell-abc123-build:/build', 'qare-web:test', 'true'],
    ['cp', '/tmp/qare-install-head-x1/.', 'qare-cell-abc123-load:/build'],
    ['rm', '-f', 'qare-cell-abc123-load'],
  ])
  cell.spawn('/tmp/qare-install-head-x1/greeter/greeter', ['--no-sandbox'])
  const args = spawned[1]?.args ?? []
  // The install is where the driver was told it is, read-only, and the checkout is not in the cell at all.
  expect(args.join(' ')).toContain('-v qare-cell-abc123-build:/tmp/qare-install-head-x1:ro -w /tmp/qare-install-head-x1')
  expect(args.join(' ')).not.toContain('/work/repo')
  await cell.dispose()
  expect(calls.slice(-2)).toEqual([['volume', 'rm', '-f', 'qare-cell-abc123'], ['volume', 'rm', '-f', 'qare-cell-abc123-build']])

  const failing = fakeDocker({ fail: { cp: 'Error response from daemon: no space left on device' } })
  await expect(startClientCell({ ...OPTS, docker: failing.docker, install })).rejects.toThrow(
    'the cell could not be made: the installed build could not be copied into it: Error response from daemon: no space left on device',
  )
  expect(failing.calls.slice(-4)).toEqual([
    ['rm', '-f', 'qare-cell-abc123-load'],
    ['rm', '-f', 'qare-cell-abc123-gate'],
    ['volume', 'rm', '-f', 'qare-cell-abc123'],
    ['volume', 'rm', '-f', 'qare-cell-abc123-build'],
  ])
  // An install is an absolute path of the run's own making, and is held to looking like one.
  await expect(startClientCell({ ...OPTS, docker: fakeDocker().docker, install: 'relative/dir' })).rejects.toThrow(/the build's directory is not an absolute path/)
})
