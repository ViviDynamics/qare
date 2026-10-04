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
      const verb = args[0] as string
      const failure = script.fail?.[verb]
      if (failure !== undefined) return { code: 1, stdout: '', stderr: failure }
      if (verb === 'inspect') return { code: 0, stdout: `${script.inspect ?? '172.17.0.1'}\n`, stderr: '' }
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
  hosts: ['app.example.test', 'api.stubs.test'],
  map: { 'app.example.test': '172.17.0.1', 'api.stubs.test': 'billing-stub' },
  app: { port: 3000, protocol: 'http' as const },
  network: 'stack_default',
  checkout: '/work/repo',
  scratch: ['tmp/scratch'],
  uid: 1001,
  gid: 118,
  id: 'abc123',
}

test('a command cell is a gate on the default bridge that joins the stack, and a command with no network (#224)', async () => {
  const { docker, calls, spawned } = fakeDocker()
  const cell = await startCommandCell({ ...OPTS, docker })

  // The gate: the declared hosts, the app's port and scheme, each stub dialed as its service.
  expect(spawned[0]?.args).toEqual([
    'run', '--rm', '--name', 'qare-cell-abc123-gate',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-u', '1001:118', '-e', 'HOME=/tmp',
    '-v', 'qare-cell-abc123:/run/qare-cell',
    'qare-web:test', 'qare', 'cell', 'gate', '--socket-dir', '/run/qare-cell',
    '--host', 'app.example.test', '--host', 'api.stubs.test',
    '--port', '3000', 'http',
    '--map', 'app.example.test=172.17.0.1', '--map', 'api.stubs.test=billing-stub',
  ])
  // A second interface, where the stubs live.
  expect(calls[1]).toEqual(['network', 'connect', 'stack_default', 'qare-cell-abc123-gate'])
  // The address the app is published at.
  expect(calls[2]).toEqual(['inspect', '--format', '{{(index .NetworkSettings.Networks "bridge").Gateway}}', 'qare-cell-abc123-gate'])

  // The checkout is copied in, never mounted from the machine.
  expect(calls.slice(3)).toEqual([
    ['volume', 'create', 'qare-cell-abc123-build'],
    ['create', '--name', 'qare-cell-abc123-load', '-v', 'qare-cell-abc123-build:/checkout', 'qare-web:test', 'true'],
    ['cp', '/work/repo/.', 'qare-cell-abc123-load:/checkout'],
    ['rm', '-f', 'qare-cell-abc123-load'],
  ])

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
  expect(calls.at(-1)).toEqual(['network', 'rm', '-f', 'stack_default'])
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

test('a gate that is never ready takes the cell down with it, and says what it was (#224)', async () => {
  const { docker, calls } = fakeDocker({ fail: { gate: 'no such image' } })
  await expect(startCommandCell({ ...OPTS, docker, readyTimeoutMs: 100 })).rejects.toThrow(
    'the cell could not be made: the gate exited with code 125 before it was ready: no such image',
  )
  expect(calls.at(-1)).toEqual(['network', 'rm', '-f', 'stack_default'])
})
