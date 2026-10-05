import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { launchInCell, runCellCommand } from '../src/cell-launch.js'
import { askGate } from './cell-sockets.js'

function seams(events: string[]) {
  return {
    startShim: async (opts: { socketDir: string; cdpPort: number; appPort?: number; appScheme?: 'http' | 'https'; stubPorts?: { host: string; port: number }[] }) => {
      events.push(`shim ${opts.socketDir} ${opts.cdpPort}${opts.appPort === undefined ? '' : ` app=${opts.appPort} ${String(opts.appScheme)}`}${opts.stubPorts === undefined ? '' : ` stubs=${opts.stubPorts.map((stub) => `${stub.host}:${stub.port}`).join(' ')}`}`)
      return { ports: { dns: 53, http: 80, https: 443 }, stop: async () => void events.push('shim stopped') }
    },
    xvfb: () => '/usr/bin/Xvfb',
    startDisplay: async (xvfb: string) => {
      events.push(`display ${xvfb}`)
      return { display: ':42', stop: async () => void events.push('display stopped') }
    },
  }
}

test('the launcher gives the build a network to ask, a display to open on, and its own exit code (#223)', async () => {
  const events: string[] = []
  let output = ''
  const code = await launchInCell({
    command: '/bin/sh',
    args: ['-c', 'echo "display $DISPLAY home $HOME"; exit 7'],
    socketDir: '/run/qare-cell',
    cdpPort: 9222,
    env: { PATH: process.env.PATH, HOME: '/tmp' },
    err: (line) => events.push(`err ${line}`),
    signals: new EventEmitter(),
    spawnBuild: (command, args, env) => {
      events.push('build started')
      const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'inherit'] })
      child.stdout.on('data', (chunk) => (output += String(chunk)))
      return child
    },
    ...seams(events),
  })
  expect(code).toBe(7)
  expect(output).toBe('display :42 home /tmp\n')
  // The network and the display are there before the build is, and gone after it.
  expect(events).toEqual(['shim /run/qare-cell 9222', 'display /usr/bin/Xvfb', 'build started', 'display stopped', 'shim stopped'])
})

test('a signal sent to the launcher is the build\'s to answer, and a build ended by one says which (#223)', async () => {
  const events: string[] = []
  const signals = new EventEmitter()
  const launched = launchInCell({
    command: '/bin/sh',
    args: ['-c', 'trap "exit 3" TERM; while :; do sleep 0.05; done'],
    socketDir: '/run/qare-cell',
    cdpPort: 9222,
    env: { PATH: process.env.PATH },
    err: () => {},
    signals,
    ...seams(events),
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  signals.emit('SIGTERM')
  expect(await launched).toBe(3)

  const killed = launchInCell({ command: '/bin/sh', args: ['-c', 'kill -KILL $$'], socketDir: '/run/qare-cell', cdpPort: 9222, env: { PATH: process.env.PATH }, err: () => {}, signals, ...seams(events) })
  // 128 and the signal's number, as a shell reports it.
  expect(await killed).toBe(137)
})

test('a command launch runs headless: no display asked for, none started (#224)', async () => {
  const events: string[] = []
  let output = ''
  const code = await launchInCell({
    command: '/bin/sh',
    args: ['-c', 'echo "display $DISPLAY"; exit 5'],
    socketDir: '/run/qare-cell',
    cdpPort: 9222,
    noDisplay: true,
    env: { PATH: process.env.PATH, HOME: '/tmp' },
    err: (line) => events.push(`err ${line}`),
    signals: new EventEmitter(),
    spawnBuild: (command, args, env) => {
      events.push('build started')
      const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'inherit'] })
      child.stdout.on('data', (chunk) => (output += String(chunk)))
      return child
    },
    ...seams(events),
    xvfb: () => undefined,
  })
  expect(code).toBe(5)
  expect(output).toBe('display \n')
  expect(events).toEqual(['shim /run/qare-cell 9222', 'build started', 'shim stopped'])
})

test('a cell with no display to start, or no way to ask the gate, starts no build and says why (#223)', async () => {  const events: string[] = []
  const said: string[] = []
  const base = { command: '/bin/sh', args: ['-c', 'exit 0'], socketDir: '/run/qare-cell', cdpPort: 9222, env: {}, err: (line: string) => said.push(line), signals: new EventEmitter() }
  const started = (): never => {
    throw new Error('the build was started')
  }
  expect(await launchInCell({ ...base, ...seams(events), xvfb: () => undefined, spawnBuild: started })).toBe(70)
  expect(said).toEqual(['qare cell: no Xvfb is on PATH to start a virtual display for the build; the web image ships it'])
  // What was started is stopped.
  expect(events).toEqual(['shim /run/qare-cell 9222', 'shim stopped'])

  said.length = 0
  const noShim = { ...seams(events), startShim: async () => Promise.reject(new Error('listen EACCES 127.0.0.1:53')) }
  expect(await launchInCell({ ...base, ...noShim, spawnBuild: started })).toBe(70)
  expect(said).toEqual(['qare cell: the cell\'s network could not be set up: listen EACCES 127.0.0.1:53'])

  said.length = 0
  expect(await launchInCell({ ...base, ...seams(events), command: '/nonexistent/build' })).toBe(70)
  expect(said[0]).toMatch(/^qare cell: the build could not be started: /)
})

test('qare cell launch and qare cell gate read their arguments, and refuse what is not theirs (#223)', async () => {
  const said: string[] = []
  const io = { out: () => {}, err: (line: string) => said.push(line), signals: new EventEmitter() }
  expect(await runCellCommand([], io)).toBe(4)
  expect(await runCellCommand(['launch', '--socket-dir', '/run/qare-cell', '--cdp-port', '9222'], io)).toBe(4)
  expect(await runCellCommand(['launch', '--cdp-port', '9222', '--', '/bin/true'], io)).toBe(4)
  expect(await runCellCommand(['gate', '--host', 'api.example.test'], io)).toBe(4)
  expect(await runCellCommand(['gate', '--socket-dir', '/tmp', '--host', 'not a host'], io)).toBe(4)
  expect(said).toEqual([
    'usage: qare cell gate --socket-dir <dir> [--host <name>]... [--port <port> <scheme>] [--map <host>=<name>]... [--stub <host>:<port>]... [--app <host>:<port>[:<dial-port>]] | qare cell launch --socket-dir <dir> --cdp-port <port> [--no-display] [--stub <host>:<port>]... -- <command> [args...]',
    'qare cell launch: no command to launch after --',
    'qare cell launch: --socket-dir is required',
    'qare cell gate: --socket-dir is required',
    'qare cell gate: "not a host" is not a host name',
  ])
})

test('qare cell gate reads the port, the mapping and the app a stack needs, and refuses what is malformed (#224)', async () => {
  const said: string[] = []
  const io = { out: () => {}, err: (line: string) => said.push(line), signals: new EventEmitter() }
  expect(await runCellCommand(['gate', '--socket-dir', '/tmp', '--port', '3000'], io)).toBe(4)
  expect(await runCellCommand(['gate', '--socket-dir', '/tmp', '--port', '3000', 'gopher'], io)).toBe(4)
  expect(await runCellCommand(['gate', '--socket-dir', '/tmp', '--map', 'no-equals-sign'], io)).toBe(4)
  expect(await runCellCommand(['gate', '--socket-dir', '/tmp', '--map', '=billing-stub'], io)).toBe(4)
  expect(await runCellCommand(['gate', '--socket-dir', '/tmp', '--map', 'not a host=stub'], io)).toBe(4)
  expect(await runCellCommand(['gate', '--socket-dir', '/tmp', '--app', 'localhost'], io)).toBe(4)
  expect(await runCellCommand(['gate', '--socket-dir', '/tmp', '--app', 'localhost:x:3000'], io)).toBe(4)
  expect(await runCellCommand(['gate', '--socket-dir', '/tmp', '--app', 'not a host:3000'], io)).toBe(4)
  expect(await runCellCommand(['gate', '--socket-dir', '/tmp', '--app', 'localhost:70000:3000'], io)).toBe(4)
  expect(await runCellCommand(['gate', '--socket-dir', '/tmp', '--stub', 'not a host:8080'], io)).toBe(4)
  expect(said).toEqual([
    'qare cell gate: --port must be a port and a scheme, http or https',
    'qare cell gate: --port must be a port and a scheme, http or https',
    'qare cell gate: "no-equals-sign" is not a <host>=<name> mapping',
    'qare cell gate: "=billing-stub" is not a <host>=<name> mapping',
    'qare cell gate: "not a host=stub" is not a <host>=<name> mapping',
    'qare cell gate: "localhost" is not an <host>:<port>[:<dial-port>] app',
    'qare cell gate: "localhost:x:3000" is not an <host>:<port>[:<dial-port>] app',
    'qare cell gate: "not a host:3000" is not an <host>:<port>[:<dial-port>] app',
    'qare cell gate: "localhost:70000:3000" is not an <host>:<port>[:<dial-port>] app',
    'qare cell gate: --stub must be a <host>:<port> pair, the host a declared stub is dialed by and the port its service answers on',
  ])
  const dir = await mkdtemp(join(tmpdir(), 'qare-cell-cmd-'))
  const lines: string[] = []
  const signals = new EventEmitter()
  let ready: (() => void) | undefined
  const isReady = new Promise<void>((resolve) => (ready = resolve))
  const running = runCellCommand(
    ['gate', '--socket-dir', dir, '--relay-port', '0', '--host', 'api.example.test', '--port', '3000', 'http', '--map', 'api.example.test=billing-stub', '--app', 'api.example.test:3000'],
    { out: (line) => (lines.push(line), ready?.()), err: () => {}, signals },
  )
  await isReady
  // The launcher attaches its signal listeners when the gate is up; give it that tick.
  await new Promise((resolve) => setImmediate(resolve))
  signals.emit('SIGTERM')
  expect(await running).toBe(0)
  // The gate started with what the run handed it: the summary closes it.
  expect(JSON.parse(lines.at(-1) as string).event).toBe('summary')
})

test('qare cell gate holds a mapped host to the stub ports the run hands it (#224)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-cell-cmd-'))
  const lines: string[] = []
  const signals = new EventEmitter()
  let ready: (() => void) | undefined
  const isReady = new Promise<void>((resolve) => (ready = resolve))
  const running = runCellCommand(
    ['gate', '--socket-dir', dir, '--relay-port', '0', '--host', 'api.example.test', '--map', 'api.example.test=billing-stub', '--stub', 'api.example.test:8080'],
    { out: (line) => (lines.push(line), ready?.()), err: () => {}, signals },
  )
  await isReady
  // The gate asks the shim's bindings no questions: a port the stub does not
  // name is refused on the gate's own account, over the mounted socket.
  const asked = await askGate(dir, { op: 'connect', host: 'api.example.test', port: 8081 })
  expect(asked.reply).toEqual({ ok: false, reason: 'a stub answers on the gate\'s own two and the ports its stub declares only' })
  signals.emit('SIGTERM')
  expect(await running).toBe(0)
  expect(JSON.parse(lines.at(-1) as string).event).toBe('summary')
})

test('the launcher hands the shim the app port the run named, and refuses a second one (#224)', async () => {
  const events: string[] = []
  const code = await launchInCell({
    command: '/bin/sh',
    args: ['-c', 'exit 0'],
    socketDir: '/run/qare-cell',
    cdpPort: 9222,
    appPort: 30007,
    appScheme: 'http',
    env: { PATH: process.env.PATH },
    err: () => events.push('err'),
    signals: new EventEmitter(),
    ...seams(events),
  })
  expect(code).toBe(0)
  expect(events).toEqual(['shim /run/qare-cell 9222 app=30007 http', 'display /usr/bin/Xvfb', 'display stopped', 'shim stopped'])
  const said: string[] = []
  const io = { out: () => {}, err: (line: string) => said.push(line), signals: new EventEmitter() }
  expect(
    await runCellCommand(['launch', '--socket-dir', '/tmp', '--cdp-port', '9222', '--port', '30007', 'http', '--port', '30008', 'https', '--', '/bin/true'], io),
  ).toBe(4)
  expect(said).toEqual(['qare cell launch: one --port is all a launch carries'])
})

test('the launcher hands the shim the stub ports the profile named, and refuses what is malformed (#224)', async () => {
  const events: string[] = []
  const code = await launchInCell({
    command: '/bin/sh',
    args: ['-c', 'exit 0'],
    socketDir: '/run/qare-cell',
    cdpPort: 9222,
    noDisplay: true,
    stubPorts: [
      { host: 'api.billing-vendor.example', port: 8080 },
      { host: 'api.mailgun.net', port: 8081 },
      { host: 'api.mailgun.net', port: 8082 },
    ],
    env: { PATH: process.env.PATH },
    err: () => events.push('err'),
    signals: new EventEmitter(),
    ...seams(events),
  })
  expect(code).toBe(0)
  expect(events).toEqual([
    'shim /run/qare-cell 9222 stubs=api.billing-vendor.example:8080 api.mailgun.net:8081 api.mailgun.net:8082',
    'shim stopped',
  ])
  const said: string[] = []
  const io = { out: () => {}, err: (line: string) => said.push(line), signals: new EventEmitter() }
  const launch = (...flags: string[]): Promise<number> => runCellCommand(['launch', '--socket-dir', '/tmp', '--cdp-port', '9222', ...flags, '--', '/bin/true'], io)
  expect(await launch('--stub', 'api.billing-vendor.example')).toBe(4)
  expect(await launch('--stub', 'api.billing-vendor.example:not-a-port')).toBe(4)
  expect(await launch('--stub', 'not a host:8080')).toBe(4)
  expect(await launch('--stub', 'api.billing-vendor.example:0')).toBe(4)
  expect(await launch('--stub', 'api.billing-vendor.example:70000')).toBe(4)
  expect(said).toEqual([
    'qare cell launch: --stub must be a <host>:<port> pair, the host a declared stub is dialed by and the port its service answers on',
    'qare cell launch: --stub must be a <host>:<port> pair, the host a declared stub is dialed by and the port its service answers on',
    'qare cell launch: --stub must be a <host>:<port> pair, the host a declared stub is dialed by and the port its service answers on',
    'qare cell launch: --stub must be a <host>:<port> pair, the host a declared stub is dialed by and the port its service answers on',
    'qare cell launch: --stub must be a <host>:<port> pair, the host a declared stub is dialed by and the port its service answers on',
  ])
})

test('qare cell gate serves until it is told to stop, then writes its record (#223)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-cell-cmd-'))
  const lines: string[] = []
  const signals = new EventEmitter()
  let ready: (() => void) | undefined
  const isReady = new Promise<void>((resolve) => (ready = resolve))
  const running = runCellCommand(['gate', '--socket-dir', dir, '--relay-port', '0', '--host', 'api.example.test'], {
    out: (line) => {
      lines.push(line)
      ready?.()
    },
    err: () => {},
    signals,
  })
  await isReady
  // One refused lookup, asked the way the cell asks.
  expect((await askGate(dir, { op: 'resolve', host: 'evil.example.test' })).reply).toEqual({ ok: false, reason: 'undeclared' })
  signals.emit('SIGTERM')
  expect(await running).toBe(0)
  expect(JSON.parse(lines.at(-1) as string)).toEqual({
    event: 'summary',
    capped: false,
    reached: [{ host: 'evil.example.test', port: 53, protocol: 'dns', declared: false, count: 1 }],
  })
  await rm(dir, { recursive: true, force: true })
})
