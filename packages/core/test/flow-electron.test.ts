import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { expect, test } from 'vitest'
import { ELECTRON_FLOW_DRIVER, ElectronFlowSessionError, electronDisplayProblem, makeElectronFlowSession, pathInApplication } from '../src/flow-electron.js'

const ENDPOINT = 'ws://127.0.0.1:41000/devtools/browser/abc'
const HOME = 'file:///opt/app/resources/app/renderer/index.html'
const WITH_DISPLAY = { DISPLAY: ':99' }

/** A process that behaves as the application does: it prints, opens its endpoint, and exits when told to. */
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  signals: string[] = []
  ignores: string[] = []
  kill(signal: string = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (!this.ignores.includes(signal)) queueMicrotask(() => this.emit('exit', signal === 'SIGTERM' ? 0 : null, signal === 'SIGTERM' ? null : signal))
    return true
  }
}

interface FakeWindow {
  page: Record<string, unknown>
  emit: (event: string, arg?: unknown) => void
  close: () => void
  show: (...names: string[]) => void
}

function fakeWindow(events: string[], title: string, url: string, shows: string[] = []): FakeWindow {
  const emitter = new EventEmitter()
  const visible = new Set(shows)
  let closed = false
  const locator = (name: string) => {
    const self = {
      click: async () => events.push(`click ${name} in ${title}`),
      fill: async (value: string) => events.push(`fill ${name}=${value} in ${title}`),
      selectOption: async (value: { label: string }) => events.push(`choose ${name}=${value.label} in ${title}`),
      isVisible: async () => visible.has(name),
      first: () => self,
    }
    return self
  }
  const page = {
    url: () => url,
    title: async () => title,
    isClosed: () => closed,
    on: (event: string, handler: (arg: unknown) => void) => emitter.on(event, handler),
    waitForLoadState: async (state: string) => events.push(`loaded ${title} to ${state}`),
    goto: async (target: string, opts: { waitUntil: string }) => events.push(`goto ${target} until ${opts.waitUntil} in ${title}`),
    getByRole: (role: string, options: { name: string }) => locator(`${role}=${options.name}`),
    getByTestId: (testId: string) => locator(`testId=${testId}`),
    getByText: (text: string) => locator(`text=${text}`),
    locator: (selector: string) => ({ selector }),
    screenshot: async (opts: unknown) => events.push(`screenshot ${JSON.stringify(opts)} of ${title}`),
    ariaSnapshot: async () => `- heading "${title}" [level=1]`,
  }
  return {
    page,
    emit: (event, arg) => emitter.emit(event, arg),
    close: () => {
      closed = true
      emitter.emit('close')
    },
    show: (...names) => {
      for (const name of names) visible.add(name)
    },
  }
}

function harness(opts: { windows?: FakeWindow[]; announce?: boolean; env?: Record<string, string>; platform?: NodeJS.Platform; masks?: string[] } = {}) {
  const events: string[] = []
  const process = new FakeProcess()
  const spawned: Array<{ command: string; args: string[] }> = []
  const windows: FakeWindow[] = opts.windows ?? []
  const onPage: Array<(page: unknown) => void> = []
  const context = {
    pages: () => windows.filter((window) => !(window.page.isClosed as () => boolean)()).map((window) => window.page),
    on: (event: string, handler: (page: unknown) => void) => {
      if (event === 'page') onPage.push(handler)
    },
    tracing: {
      start: async (traceOpts: unknown) => events.push(`trace start ${JSON.stringify(traceOpts)}`),
      stop: async (traceOpts: { path: string }) => events.push(`trace stop ${traceOpts.path}`),
    },
  }
  const playwright = {
    chromium: {
      connectOverCDP: async (endpoint: string) => {
        events.push(`connect ${endpoint}`)
        return { contexts: () => [context], close: async () => events.push('disconnect') }
      },
    },
  }
  const session = () =>
    makeElectronFlowSession({
      executable: '/opt/app/app',
      args: ['--no-sandbox'],
      ...(opts.masks === undefined ? {} : { masks: opts.masks }),
      loadPlaywright: async () => playwright as never,
      spawnApp: (command, args) => {
        spawned.push({ command, args })
        if (opts.announce !== false)
          setTimeout(() => {
            process.stdout.emit('data', 'main: ready\n')
            process.stderr.emit('data', `\nDevTools listening on ${ENDPOINT}\n`)
          }, 0)
        return process as never
      },
      env: opts.env ?? WITH_DISPLAY,
      platform: opts.platform ?? 'linux',
      launchTimeoutMs: 80,
      findTimeoutMs: 60,
      pollIntervalMs: 2,
      closeGraceMs: 20,
    })
  const open = (window: FakeWindow): void => {
    windows.push(window)
    for (const handler of onPage) handler(window.page)
  }
  return { events, process, spawned, windows, session, open }
}

test('the session starts the build itself, attaches over the endpoint it opens, and gives each launch a user data directory of its own (#72)', async () => {
  const main = fakeWindow([], 'Greeter', HOME)
  const { events, spawned, session, process } = harness({ windows: [main] })
  const started = await session()

  expect(started.capabilities).toBe(ELECTRON_FLOW_DRIVER)
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.command).toBe('/opt/app/app')
  // The profile's arguments first, then the two the driver owns.
  expect(spawned[0]?.args.slice(0, 2)).toEqual(['--no-sandbox', '--remote-debugging-port=0'])
  const userData = /^--user-data-dir=(.+qare-electron-.+)$/.exec(spawned[0]?.args[2] ?? '')?.[1] ?? ''
  expect(existsSync(userData)).toBe(true)
  expect(events).toContain(`connect ${ENDPOINT}`)

  await started.dispose()
  // Closing is the process's to do: asked first, and the directory goes with it.
  expect(process.signals).toEqual(['SIGTERM'])
  expect(existsSync(userData)).toBe(false)
  // Disposing twice is disposing once.
  await started.dispose()
  expect(process.signals).toEqual(['SIGTERM'])
})

test('a process that ignores the request to close is killed, so no application outlives its check (#72)', async () => {
  const { session, process } = harness({ windows: [fakeWindow([], 'Greeter', HOME)] })
  const started = await session()
  process.ignores = ['SIGTERM']
  await started.dispose()
  expect(process.signals).toEqual(['SIGTERM', 'SIGKILL'])
})

test('the backend that is not installed, and a host with no display, are named before anything is started (#72)', async () => {
  const missing = makeElectronFlowSession({
    executable: '/opt/app/app',
    loadPlaywright: async () => {
      const error = new Error('not found') as NodeJS.ErrnoException
      error.code = 'ERR_MODULE_NOT_FOUND'
      throw error
    },
  })
  await expect(missing).rejects.toThrow(ElectronFlowSessionError)
  await expect(missing).rejects.toThrow('playwright-core is not installed; the electron driver attaches to the application through it')

  const headless = harness({ env: {} })
  await expect(headless.session()).rejects.toThrow(/the electron driver needs a display, and neither DISPLAY nor WAYLAND_DISPLAY is set/)
  expect(headless.spawned).toEqual([])

  expect(electronDisplayProblem({}, 'linux')).toMatch(/needs a display/)
  expect(electronDisplayProblem({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBeUndefined()
  // Only Linux names its display in the environment.
  expect(electronDisplayProblem({}, 'darwin')).toBeUndefined()
  expect(electronDisplayProblem({}, 'win32')).toBeUndefined()
})

test('an application that exits, or never opens its endpoint, fails the start with its own output named (#72)', async () => {
  const crashed = harness({ announce: false })
  const starting = crashed.session()
  setTimeout(() => {
    crashed.process.stderr.emit('data', 'main: cannot find module ./missing\n')
    crashed.process.emit('exit', 1, null)
  }, 0)
  await expect(starting).rejects.toThrow(/the application exited with code 1 before the driver could attach; its output: \[main stderr\] main: cannot find module \.\/missing/)

  const silent = harness({ announce: false })
  await expect(silent.session()).rejects.toThrow(/opened no DevTools endpoint within 80 ms.*a build that turns remote debugging off cannot be driven/)
  // Nothing is left running behind a start that failed.
  expect(silent.process.signals).toContain('SIGTERM')

  const windowless = harness({ windows: [] })
  await expect(windowless.session()).rejects.toThrow(/the application opened no window within 80 ms/)
  expect(windowless.process.signals).toContain('SIGTERM')
})

test('the vocabulary drives the window that shows the element, with the browser\'s own locators (#72)', async () => {
  const events: string[] = []
  const main = fakeWindow(events, 'Greeter', HOME, ['textbox=Name', 'combobox=Greeting', 'button=Greet', 'testId=greet'])
  const { session } = harness({ windows: [main] })
  const started = await session()

  await started.page.type({ role: 'textbox', name: 'Name' }, 'Ada')
  await started.page.choose({ role: 'combobox', name: 'Greeting' }, 'Good evening')
  await started.page.click({ role: 'button', name: 'Greet' })
  await started.page.click({ testId: 'greet' })
  await started.page.waitFor({ role: 'button', name: 'Greet' })
  await started.dispose()

  expect(events.filter((event) => / in Greeter$/.test(event))).toEqual([
    'fill textbox=Name=Ada in Greeter',
    'choose combobox=Greeting=Good evening in Greeter',
    'click button=Greet in Greeter',
    'click testId=greet in Greeter',
  ])
})

test('an element is looked for in every open window, newest first, so a flow follows the application into a window it opens and back (#72)', async () => {
  const events: string[] = []
  const main = fakeWindow(events, 'Greeter', HOME, ['button=Open details', 'button=Shared', 'text=Greeter'])
  const { session, open } = harness({ windows: [main] })
  const started = await session()

  await started.page.click({ role: 'button', name: 'Open details' })
  // The window opens while the flow is already waiting for what it shows.
  const details = fakeWindow(events, 'Details', 'file:///opt/app/resources/app/renderer/details.html', ['button=Close details', 'button=Shared', 'text=Details'])
  setTimeout(() => open(details), 10)
  await started.page.waitFor({ role: 'button', name: 'Close details' })
  // Both windows show it: the newest one is where a person is looking.
  await started.page.click({ role: 'button', name: 'Shared' })
  await started.page.assertText('Details')
  await started.page.screenshot('/tmp/details.png')
  // An element only the older window shows is still reached there.
  await started.page.assertText('Greeter')
  await started.page.screenshot('/tmp/greeter.png')
  await started.page.click({ role: 'button', name: 'Close details' })
  details.close()
  await started.page.click({ role: 'button', name: 'Shared' })
  await started.page.screenshot('/tmp/after.png')
  await started.dispose()

  expect(events.filter((event) => /^(click|screenshot)/.test(event))).toEqual([
    'click button=Open details in Greeter',
    'click button=Shared in Details',
    'screenshot {"path":"/tmp/details.png"} of Details',
    'screenshot {"path":"/tmp/greeter.png"} of Greeter',
    'click button=Close details in Details',
    'click button=Shared in Greeter',
    'screenshot {"path":"/tmp/after.png"} of Greeter',
  ])
})

test('an element no window shows fails the action naming the element and the windows that are open (#72)', async () => {
  const main = fakeWindow([], 'Greeter', HOME)
  const { session } = harness({ windows: [main] })
  const started = await session()

  await expect(started.page.click({ role: 'button', name: 'Missing' })).rejects.toThrow(
    'no open window shows role=button name=Missing within 60 ms (open windows: 1 "Greeter")',
  )
  await expect(started.page.waitFor({ testId: 'gone' })).rejects.toThrow(/no open window shows testId=gone/)
  // An assertion is the page as it stands: it does not wait.
  await expect(started.page.assertText('Hello')).rejects.toThrow('assert failed: the text "Hello" is not visible in any open window')
  await expect(started.page.assertElement({ role: 'status', name: 'Greeting shown' })).rejects.toThrow('assert failed: the element is not visible in any open window')
  main.close()
  await expect(started.page.screenshot('/tmp/none.png')).rejects.toThrow('the application has no window open')
  await started.dispose()
})

test('open takes a path inside the application, resolved against the page its first window loaded (#72)', async () => {
  const events: string[] = []
  const { session } = harness({ windows: [fakeWindow(events, 'Greeter', HOME)] })
  const started = await session()

  await started.page.open('/')
  await started.page.open('/details.html')
  await expect(started.page.open(['https:', '//example.test/'].join(''))).rejects.toThrow(/the electron driver opens a path inside the application, not "https:\/\/example\.test\/"/)
  await expect(started.page.open('/../../etc/passwd')).rejects.toThrow(/climbs out of the application/)
  await started.dispose()

  expect(events.filter((event) => event.startsWith('goto'))).toEqual([
    `goto ${HOME} until networkidle in Greeter`,
    'goto file:///opt/app/resources/app/renderer/details.html until networkidle in Greeter',
  ])

  expect(pathInApplication(HOME, '/')).toBe(HOME)
  expect(pathInApplication('app://bundle/index.html', '/settings/profile')).toBe('app://bundle/settings/profile')
  expect(() => pathInApplication(HOME, 'details.html')).toThrow(/a path inside the application/)
})

test('screenshots black out the profile masks, and the snapshot is the current window\'s tree in the normalised schema (#72)', async () => {
  const events: string[] = []
  const { session, events: driver } = harness({ windows: [fakeWindow(events, 'Greeter', HOME)], masks: ['css=.secret'] })
  const started = await session()

  await started.page.screenshot('/tmp/final.png')
  const snapshot = await started.page.snapshot?.()
  await started.trace.start()
  await started.trace.stop('/tmp/trace.zip')
  await started.dispose()

  expect(events).toContain('screenshot {"path":"/tmp/final.png","mask":[{"selector":"css=.secret"}],"maskColor":"#000000"} of Greeter')
  expect(snapshot?.children[0]).toMatchObject({ role: 'heading', name: 'Greeter' })
  expect(driver).toContain('trace start {"screenshots":true,"snapshots":true}')
  expect(driver).toContain('trace stop /tmp/trace.zip')
  // An audit seam is absent on purpose: the driver declares no a11y check.
  expect(started.page.audit).toBeUndefined()
})

test('the application\'s own output is kept from its first byte: both streams by line, every window\'s console, and what opened and closed (#72)', async () => {
  const main = fakeWindow([], 'Greeter', HOME)
  const { session, process, open } = harness({ windows: [main] })
  const started = await session()

  process.stdout.emit('data', 'main: half a ')
  process.stdout.emit('data', 'line\nmain: second\r\n')
  process.stderr.emit('data', Buffer.from('main: warned\n'))
  main.emit('console', { type: () => 'log', text: () => 'renderer: greeted Ada' })
  main.emit('pageerror', new Error('boom'))
  const details = fakeWindow([], 'Details', 'file:///opt/app/details.html')
  open(details)
  details.emit('console', { type: () => 'warning', text: () => 'renderer: details ready' })
  details.close()
  process.stdout.emit('data', 'main: no newline at exit')
  await started.dispose()

  expect(started.console()).toEqual([
    // Written before the driver had attached, and still here.
    '[main stdout] main: ready',
    `[window 1 opened] ${HOME}`,
    '[main stdout] main: half a line',
    '[main stdout] main: second',
    '[main stderr] main: warned',
    '[window 1 console.log] renderer: greeted Ada',
    '[window 1 error] boom',
    '[window 2 opened] file:///opt/app/details.html',
    '[window 2 console.warning] renderer: details ready',
    '[window 2 closed]',
    '[main stdout] main: no newline at exit',
    '[main exited] code 0',
  ])
  // The endpoint line is the driver's own doing, not the application's.
  expect(started.console().join('\n')).not.toContain('DevTools listening')
})
