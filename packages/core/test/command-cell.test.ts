import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import { startCommandCell } from '../src/command-cell.js'
import { type CellDocker, type CellProcess } from '../src/client-cell.js'

/** A docker that records every call and plays the gate's and the command's containers. */
function fakeDocker(script: { gateLines?: string[]; gateExit?: number; fail?: Record<string, string>; inspect?: string } = {}) {
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
      const [verb, sub] = args as [string, string]
      const failure = script.fail?.[verb]
      if (failure !== undefined) return { code: 1, stdout: '', stderr: failure }
      if (verb === 'network' && sub === 'ls') return { code: 0, stdout: 'stack_default\n', stderr: '' }
      if (verb === 'network' && sub === 'inspect') return { code: 0, stdout: `${script.inspect ?? '172.17.0.1'}\n`, stderr: '' }
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
  hosts: ['api.stubs.test'],
  map: { 'api.stubs.test': 'billing-stub' },
  app: { host: 'localhost', port: 3000, scheme: 'http' as const },
  composeProject: 'stack',
  checkout: '/work/repo',
  scratch: ['tmp/scratch'],
  uid: 1001,
  gid: 118,
  id: 'abc123',
}

test('a command cell is a gate on the default bridge that joins the stack, and a command with no network (#224)', async () => {
  const { docker, calls, spawned } = fakeDocker()
  const cell = await startCommandCell({ ...OPTS, docker })

  // The stack's network and the address the app is published at are asked
  // before anything is made: the map is in the gate's argv.
  expect(calls[0]).toEqual(['network', 'ls', '--format', '{{.Name}}', '--filter', 'label=com.docker.compose.project=stack'])
  expect(calls[1]).toEqual(['network', 'inspect', '--format', '{{(index .IPAM.Config 0).Gateway}}', 'bridge'])

  // The gate: the app's host and every stub's, the app's port and scheme,
  // each stub dialled as its service and the app dialled at the gateway.
  expect(spawned[0]?.args).toEqual([
    'run', '--rm', '--name', 'qare-cell-abc123-gate',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-u', '1001:118', '-e', 'HOME=/tmp',
    '-v', 'qare-cell-abc123:/run/qare-cell',
    'qare-web:test', 'qare', 'cell', 'gate', '--socket-dir', '/run/qare-cell',
    '--host', 'api.stubs.test', '--host', 'localhost',
    '--port', '3000', 'http',
    '--map', 'api.stubs.test=billing-stub', '--map', 'localhost=172.17.0.1',
  ])
  // A second interface, where the stubs live.
  expect(calls[3]).toEqual(['network', 'connect', 'stack_default', 'qare-cell-abc123-gate'])

  // The checkout is copied in, never mounted from the machine.
  expect(calls[4]).toEqual(['volume', 'create', 'qare-cell-abc123-build'])
  expect(calls[5]).toEqual(['create', '--name', 'qare-cell-abc123-load', '-v', 'qare-cell-abc123-build:/checkout', 'qare-web:test', 'true'])
  expect(calls[6]).toEqual(['cp', '/work/repo/.', 'qare-cell-abc123-load:/checkout'])

  cell.run(['true', '--verbose'], { FOO: 'bar' })
  expect(spawned[1]?.args).toEqual([
    'run', '--rm', '--name', 'qare-cell-abc123-command',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-u', '1001:118', '-e', 'HOME=/tmp',
    '-v', 'qare-cell-abc123:/run/qare-cell',
    '--network', 'none', '--dns', '127.0.0.1', '--dns-search', '.',
    '-v', 'qare-cell-abc123-build:/work/repo:ro',
    '-w', '/work/repo',
    '--tmpfs', '/work/repo/tmp/scratch:uid=1001,gid=118,mode=0700',
    '-e', 'FOO=bar',
    'qare-web:test', 'qare', 'cell', 'launch', '--socket-dir', '/run/qare-cell', '--cdp-port', '9222', '--port', '3000', 'http', '--',
    'true', '--verbose',
  ])

  await cell.dispose()
  expect(cell.record()).toEqual({ reached: [] })
  expect(calls.filter((args) => args[0] === 'stop')).toEqual([['stop', '-t', '10', 'qare-cell-abc123-gate']])
  // The network is the stack's own: joined, never removed.
  expect(calls.at(-1)).toEqual(['volume', 'rm', '-f', 'qare-cell-abc123', 'qare-cell-abc123-build'])
})

test('a command cell without a stack boots no interface for the stubs and carries no app port (#224)', async () => {
  const { docker, calls, spawned } = fakeDocker()
  const cell = await startCommandCell({
    image: 'qare-web:test',
    hosts: ['api.example.test'],
    checkout: '/work/repo',
    id: 'def456',
    docker,
  })
  expect(spawned[0]?.args.filter((arg) => arg === '--port' || arg === '--map')).toEqual([])
  expect(calls.find((args) => args[0] === 'network')).toBeUndefined()
  cell.run(['true'])
  expect(spawned[1]?.args.filter((arg) => arg === '--port' || arg === '--tmpfs')).toEqual([])
  await cell.dispose()
  expect(calls.at(-1)).toEqual(['volume', 'rm', '-f', 'qare-cell-def456', 'qare-cell-def456-build'])
})

test("a declared host on a port other than the gate's own two has that port carried, and is dialled as itself (#224)", async () => {
  const { docker, calls, spawned } = fakeDocker()
  const cell = await startCommandCell({
    image: 'qare-web:test',
    hosts: ['staging.example.test'],
    ports: [{ port: 8443, protocol: 'https' }],
    checkout: '/work/repo',
    id: 'efg789',
    docker,
  })
  // No app, so no gateway is asked: the target is dialled as itself.
  expect(calls.find((args) => args[0] === 'inspect')).toBeUndefined()
  expect(spawned[0]?.args.filter((arg) => arg === '--map')).toEqual([])
  expect(spawned[0]?.args.slice(spawned[0]?.args.indexOf('--host'))).toEqual(['--host', 'staging.example.test', '--port', '8443', 'https'])
  cell.run(['true'])
  expect(spawned[1]?.args.filter((arg) => arg === '--tmpfs')).toEqual([])
  expect(spawned[1]?.args.slice(spawned[1]?.args.indexOf('--port'))).toEqual(['--port', '8443', 'https', '--', 'true'])
  await cell.dispose()
})

test('an app published on the gate\'s own port is mapped to the gateway without a port of its own (#224)', async () => {
  const { docker, spawned } = fakeDocker()
  await startCommandCell({
    image: 'qare-web:test',
    hosts: [],
    app: { host: 'localhost', port: 80, scheme: 'http' },
    checkout: '/work/repo',
    id: 'fgh890',
    docker,
  })
  expect(spawned[0]?.args.filter((arg) => arg === '--port')).toEqual([])
  expect(spawned[0]?.args.filter((arg) => arg === '--map' || arg === 'localhost=172.17.0.1')).toEqual(['--map', 'localhost=172.17.0.1'])
})

test('a gate that is never ready takes the cell down with it, and says what it was (#224)', async () => {
  const { docker, calls } = fakeDocker({ fail: { gate: 'no such image' } })
  await expect(startCommandCell({ ...OPTS, docker, readyTimeoutMs: 100 })).rejects.toThrow(
    'the cell could not be made: the gate exited with code 125 before it was ready: no such image',
  )
  expect(calls.at(-1)).toEqual(['volume', 'rm', '-f', 'qare-cell-abc123', 'qare-cell-abc123-build'])
})
