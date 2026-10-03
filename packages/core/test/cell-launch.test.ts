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
    startShim: async (opts: { socketDir: string; cdpPort: number }) => {
      events.push(`shim ${opts.socketDir} ${opts.cdpPort}`)
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

test('a cell with no display to start, or no way to ask the gate, starts no build and says why (#223)', async () => {
  const events: string[] = []
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
    'usage: qare cell gate --socket-dir <dir> [--host <name>]... | qare cell launch --socket-dir <dir> --cdp-port <port> -- <command> [args...]',
    'qare cell launch: no command to launch after --',
    'qare cell launch: --socket-dir is required',
    'qare cell gate: --socket-dir is required',
    'qare cell gate: "not a host" is not a host name',
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
