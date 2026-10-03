import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import type { ClientCell } from '../src/client-cell.js'
import { ElectronFlowSessionError, makeElectronFlowSession } from '../src/flow-electron.js'

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill(signal: string = 'SIGTERM'): boolean {
    queueMicrotask(() => this.emit('exit', signal === 'SIGTERM' ? 0 : null, signal === 'SIGTERM' ? null : signal))
    return true
  }
}

function contained(opts: { crash?: boolean } = {}) {
  const events: string[] = []
  const emitter = new EventEmitter()
  const page = {
    url: () => 'file:///work/repo/dist/app/resources/app/index.html',
    title: async () => 'Greeter',
    isClosed: () => false,
    on: (event: string, handler: (arg: unknown) => void) => emitter.on(event, handler),
    waitForLoadState: async () => {},
  }
  const context = { pages: () => [page], on: () => {}, tracing: { start: async () => {}, stop: async () => {} } }
  const playwright = {
    chromium: {
      connectOverCDP: async (endpoint: string) => {
        events.push(`connect ${endpoint}`)
        return { contexts: () => [context], close: async () => events.push('disconnect') }
      },
    },
  }
  const process = new FakeProcess()
  const cell: ClientCell = {
    debuggingPort: 9222,
    userDataDir: '/tmp/qare-electron-abc123',
    spawn: (command, args) => {
      events.push(`cell spawn ${command} ${args.join(' ')}`)
      setTimeout(() => {
        if (opts.crash === true) {
          process.stderr.emit('data', 'qare cell: no Xvfb is on PATH to start a virtual display for the build; the web image ships it\n')
          process.emit('exit', 70, null)
        } else process.stderr.emit('data', 'DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc\n')
      }, 0)
      return process as never
    },
    endpoint: (printed) => printed.replace('127.0.0.1:9222', '127.0.0.1:49222'),
    record: () => {
      events.push('record read')
      return { reached: [{ host: 'api.example.test', port: 443, protocol: 'https', declared: true, count: 1 }] }
    },
    dispose: async () => void events.push('cell disposed'),
    reap: () => void events.push('cell reaped'),
  }
  const session = (start: () => Promise<ClientCell> = async () => cell) =>
    makeElectronFlowSession({
      executable: '/work/repo/dist/app/app',
      args: ['--no-sandbox'],
      loadPlaywright: async () => playwright as never,
      cell: () => {
        events.push('cell started')
        return start()
      },
      // A host with no display and no Xvfb: the cell brings its own, so neither is looked for.
      env: {},
      platform: 'linux',
      xvfb: () => undefined,
      startDisplay: async () => {
        throw new Error('a display was started outside the cell')
      },
      spawnApp: () => {
        throw new Error('the build was started outside the cell')
      },
      launchTimeoutMs: 2_000,
      pollIntervalMs: 2,
      closeGraceMs: 20,
    })
  return { events, session }
}

test('handed a cell, the driver launches the build inside it and attaches where the cell says (#223)', async () => {
  const { events, session } = contained()
  const started = await session()
  expect(events).toEqual([
    'cell started',
    // The build listens on the cell's own port, with a user data directory inside the cell.
    'cell spawn /work/repo/dist/app/app --no-sandbox --remote-debugging-port=9222 --user-data-dir=/tmp/qare-electron-abc123',
    // The endpoint the build printed is the cell's loopback; the driver attaches to the relay.
    'connect ws://127.0.0.1:49222/devtools/browser/abc',
  ])
  expect(started.reached).toBeDefined()
  await started.dispose()
  // The cell goes after the build has been asked to stop, and its record is read after that.
  expect(events.slice(3)).toEqual(['disconnect', 'cell disposed'])
  expect(started.reached?.()).toEqual({ reached: [{ host: 'api.example.test', port: 443, protocol: 'https', declared: true, count: 1 }] })
  expect(started.console().at(-1)).toBe('[main exited] code 0')
})

test('a cell that cannot be made is the session\'s failure, and nothing is launched outside it (#223)', async () => {
  const { events, session } = contained()
  await expect(session(async () => Promise.reject(new Error('the cell could not be made: the gate was not ready in time')))).rejects.toThrow(
    new ElectronFlowSessionError('the cell could not be made: the gate was not ready in time'),
  )
  expect(events).toEqual(['cell started'])
})

test('a build that never starts inside its cell takes the cell with it (#223)', async () => {
  const { events, session } = contained({ crash: true })
  await expect(session()).rejects.toThrow(/the application exited with code 70 before the driver could attach; its output: \[main stderr\] qare cell: no Xvfb is on PATH/)
  expect(events.at(-1)).toBe('cell disposed')
})

test('without a cell the session reports nothing about what the build reached (#223)', async () => {
  const process = new FakeProcess()
  const started = makeElectronFlowSession({
    executable: '/work/repo/dist/app/app',
    loadPlaywright: async () => ({ chromium: { connectOverCDP: async () => ({ contexts: () => [], close: async () => {} }) } }) as never,
    spawnApp: () => {
      setTimeout(() => process.emit('exit', 1, null), 0)
      return process as never
    },
    env: { DISPLAY: ':99' },
    platform: 'linux',
    launchTimeoutMs: 500,
    closeGraceMs: 20,
  })
  await expect(started).rejects.toThrow(/exited with code 1/)
})
