import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ELECTRON_FLOW_DRIVER, ElectronFlowSessionError, electronDisplayProblem, makeElectronFlowSession, pathInApplication, startVirtualDisplay } from '../src/flow-electron.js'

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

function harness(
  opts: {
    windows?: FakeWindow[]
    announce?: boolean | 'crash'
    env?: Record<string, string>
    platform?: NodeJS.Platform
    masks?: string[]
    launchTimeoutMs?: number
    findTimeoutMs?: number
    xvfb?: string
    environment?: 'inherit' | 'minimal'
  } = {},
) {
  const events: string[] = []
  const process = new FakeProcess()
  const spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const displays: string[] = []
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
      spawnApp: (command, args, env) => {
        spawned.push({ command, args, env })
        // Whatever the application does, it does once the driver is listening.
        setTimeout(() => {
          if (opts.announce === 'crash') {
            process.stderr.emit('data', 'main: cannot find module ./missing\n')
            process.emit('exit', 1, null)
          } else if (opts.announce !== false) {
            process.stdout.emit('data', 'main: ready\n')
            process.stderr.emit('data', `\nDevTools listening on ${ENDPOINT}\n`)
          }
        }, 0)
        return process as never
      },
      env: opts.env ?? WITH_DISPLAY,
      ...(opts.environment === undefined ? {} : { environment: opts.environment }),
      platform: opts.platform ?? 'linux',
      xvfb: () => opts.xvfb,
      startDisplay: async (xvfb) => {
        displays.push(`start ${xvfb}`)
        return { display: ':42', stop: async () => void displays.push('stop') }
      },
      // Generous by default, so a loaded machine cannot time a passing test out;
      // the tests that wait a timeout out name a short one.
      launchTimeoutMs: opts.launchTimeoutMs ?? 2_000,
      findTimeoutMs: opts.findTimeoutMs ?? 2_000,
      pollIntervalMs: 2,
      closeGraceMs: 20,
    })
  const open = (window: FakeWindow): void => {
    windows.push(window)
    for (const handler of onPage) handler(window.page)
  }
  return { events, process, spawned, windows, session, open, displays }
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
  await expect(headless.session()).rejects.toThrow(
    'the electron driver needs a display: neither DISPLAY nor WAYLAND_DISPLAY is set, and no Xvfb is on PATH to start a virtual one (the web image ships it)',
  )
  expect(headless.spawned).toEqual([])

  const none = (): undefined => undefined
  expect(electronDisplayProblem({ env: {}, platform: 'linux', xvfb: none })).toMatch(/needs a display/)
  expect(electronDisplayProblem({ env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux', xvfb: none })).toBeUndefined()
  expect(electronDisplayProblem({ env: { DISPLAY: ':0' }, platform: 'linux', xvfb: none })).toBeUndefined()
  // A host that can start a virtual display has one.
  expect(electronDisplayProblem({ env: {}, platform: 'linux', xvfb: () => '/usr/bin/Xvfb' })).toBeUndefined()
  // Only Linux names its display in the environment.
  expect(electronDisplayProblem({ env: {}, platform: 'darwin', xvfb: none })).toBeUndefined()
  expect(electronDisplayProblem({ env: {}, platform: 'win32', xvfb: none })).toBeUndefined()
})

test('a host with no display but an Xvfb gets a virtual one for the launch, stopped with the session (#72)', async () => {
  const { session, spawned, displays } = harness({ windows: [fakeWindow([], 'Greeter', HOME)], env: {}, xvfb: '/usr/bin/Xvfb' })
  const started = await session()
  expect(displays).toEqual(['start /usr/bin/Xvfb'])
  expect(spawned[0]?.env.DISPLAY).toBe(':42')
  await started.dispose()
  expect(displays).toEqual(['start /usr/bin/Xvfb', 'stop'])

  // A display the host already has is the one the application opens on.
  const own = harness({ windows: [fakeWindow([], 'Greeter', HOME)], xvfb: '/usr/bin/Xvfb' })
  await (await own.session()).dispose()
  expect(own.displays).toEqual([])
  expect(own.spawned[0]?.env.DISPLAY).toBe(':99')

  // A start that fails stops the display it started.
  const crashed = harness({ announce: 'crash', env: {}, xvfb: '/usr/bin/Xvfb' })
  await expect(crashed.session()).rejects.toThrow(/exited with code 1/)
  expect(crashed.displays).toEqual(['start /usr/bin/Xvfb', 'stop'])
})

test('on a host the build is pull request code, so it is launched with the minimal environment and never the host\'s (#72, #91)', async () => {
  const host = { DISPLAY: ':99', XAUTHORITY: '/run/user/1000/xauth', PATH: '/usr/bin', HOME: '/home/dev', HOST_TOKEN: 'ghp_host_secret' }
  const minimal = harness({ windows: [fakeWindow([], 'Greeter', HOME)], env: host, environment: 'minimal' })
  await (await minimal.session()).dispose()
  // What a window needs to open, and nothing a host happens to hold.
  expect(minimal.spawned[0]?.env).toEqual({ PATH: '/usr/bin', HOME: '/home/dev', DISPLAY: ':99', XAUTHORITY: '/run/user/1000/xauth' })

  // A virtual display the driver started is the one the build is told about.
  const virtual = harness({ windows: [fakeWindow([], 'Greeter', HOME)], env: { PATH: '/usr/bin', HOME: '/home/dev', HOST_TOKEN: 'x' }, environment: 'minimal', xvfb: '/usr/bin/Xvfb' })
  await (await virtual.session()).dispose()
  expect(virtual.spawned[0]?.env).toEqual({ PATH: '/usr/bin', HOME: '/home/dev', DISPLAY: ':42' })

  // Inside an image the environment is the image's to control, and is inherited.
  const inherited = harness({ windows: [fakeWindow([], 'Greeter', HOME)], env: host })
  await (await inherited.session()).dispose()
  expect(inherited.spawned[0]?.env.HOST_TOKEN).toBe('ghp_host_secret')
})

test('the virtual display is an Xvfb on a number of its own choosing, and one that will not start is named (#72)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-xvfb-'))
  const script = async (name: string, body: string): Promise<string> => {
    const path = join(dir, name)
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o755)
    return path
  }
  // Xvfb writes the display number it took to the descriptor it was handed.
  const working = await script('Xvfb', 'echo "$@" > "$0.args"\necho 42 >&3\nexec sleep 30')
  const display = await startVirtualDisplay(working)
  expect(display.display).toBe(':42')
  await display.stop()

  const broken = await script('broken', 'echo "cannot open the screen" >&2\nexit 1')
  await expect(startVirtualDisplay(broken)).rejects.toThrow(/the virtual display did not start: .*broken exited with code 1.*cannot open the screen/)
})

test('an application that exits, or never opens its endpoint, fails the start with its own output named (#72)', async () => {
  const crashed = harness({ announce: 'crash' })
  await expect(crashed.session()).rejects.toThrow(/the application exited with code 1 before the driver could attach; its output: \[main stderr\] main: cannot find module \.\/missing/)

  const silent = harness({ announce: false, launchTimeoutMs: 80 })
  await expect(silent.session()).rejects.toThrow(/opened no DevTools endpoint within 80 ms.*a build that turns remote debugging off cannot be driven/)
  // Nothing is left running behind a start that failed.
  expect(silent.process.signals).toContain('SIGTERM')

  const windowless = harness({ windows: [], launchTimeoutMs: 80 })
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

test('output with no line ends, or one enormous line, cannot grow the run: a line is cut at a bound and says so (#72)', async () => {
  const main = fakeWindow([], 'Greeter', HOME)
  const { session, process } = harness({ windows: [main] })
  const started = await session()

  // A megabyte with no newline, in chunks, and then the line finally ends.
  for (let chunk = 0; chunk < 64; chunk += 1) process.stdout.emit('data', 'x'.repeat(16_384))
  process.stdout.emit('data', 'tail\nmain: after\n')
  main.emit('console', { type: () => 'log', text: () => 'y'.repeat(100_000) })
  await started.dispose()

  const lines = started.console()
  const long = lines.find((line) => line.startsWith('[main stdout] xxx')) ?? ''
  expect(long.length).toBeLessThan(9_000)
  expect(long.endsWith(' [line cut at 8192 characters]')).toBe(true)
  // The rest of the cut line is dropped, not read as a line of its own.
  expect(lines.filter((line) => line.includes('xxx'))).toHaveLength(1)
  expect(lines.some((line) => line.includes('tail'))).toBe(false)
  expect(lines).toContain('[main stdout] main: after')
  const message = lines.find((line) => line.startsWith('[window 1 console.log] yyy')) ?? ''
  expect(message.length).toBeLessThan(9_000)
  expect(message.endsWith(' [line cut at 8192 characters]')).toBe(true)
})

test('a harness that exits with a session still open takes the application and its display with it (#72)', async () => {
  const before = process.listeners('exit')
  const { session, process: app, displays } = harness({ windows: [fakeWindow([], 'Greeter', HOME)], env: {}, xvfb: '/usr/bin/Xvfb' })
  const started = await session()
  const added = process.listeners('exit').filter((listener) => !before.includes(listener))
  expect(added).toHaveLength(1)
  // What the harness's own exit would do: nothing is asked, there is no time to wait.
  ;(added[0] as () => void)()
  expect(app.signals).toEqual(['SIGKILL'])
  expect(displays).toEqual(['start /usr/bin/Xvfb', 'stop'])

  await started.dispose()
  // A session that was disposed leaves nothing behind on the process.
  expect(process.listeners('exit').filter((listener) => !before.includes(listener))).toEqual([])
})

test('a window that goes away while an assertion asks it is a window that does not show the element, not a failed assertion (#72)', async () => {
  const main = fakeWindow([], 'Greeter', HOME, ['text=Greeter', 'heading=Greeter'])
  const closing = fakeWindow([], 'Details', 'file:///opt/app/details.html')
  // Asked mid-close, the page answers with an error rather than with no.
  const gone = (): never => {
    throw new Error('Target page, context or browser has been closed')
  }
  closing.page.getByText = gone
  closing.page.getByRole = gone
  const { session } = harness({ windows: [main, closing] })
  const started = await session()

  await expect(started.page.assertText('Greeter')).resolves.toBeUndefined()
  await expect(started.page.assertElement({ role: 'heading', name: 'Greeter' })).resolves.toBeUndefined()
  await started.dispose()
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
  const { session } = harness({ windows: [main], findTimeoutMs: 60 })
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

test('a frame is the current window, masked as a screenshot is, with every concealed element blacked out (#78)', async () => {
  const events: string[] = []
  const { session } = harness({ windows: [fakeWindow(events, 'Greeter', HOME)], masks: ['css=.secret'] })
  const started = await session()

  await started.page.frame?.({ conceal: [{ role: 'textbox', name: 'Passphrase' }] })
  await started.page.screenshot('/tmp/failure.png', { conceal: [{ role: 'textbox', name: 'Passphrase' }] })
  await started.dispose()

  // The second mask is the concealed element's own locator, which has nothing a string can show.
  expect(events).toEqual([
    'loaded Greeter to load',
    'screenshot {"type":"png","scale":"css","timeout":5000,"mask":[{"selector":"css=.secret"},{}],"maskColor":"#000000"} of Greeter',
    'screenshot {"path":"/tmp/failure.png","mask":[{"selector":"css=.secret"},{}],"maskColor":"#000000"} of Greeter',
  ])
})

test('a window whose renderer died says so in the output, and every line carries the moment it was written (#78)', async () => {
  const main = fakeWindow([], 'Greeter', HOME)
  const { session } = harness({ windows: [main] })
  const before = Date.now()
  const started = await session()

  main.emit('crash')
  await started.dispose()

  expect(started.console()).toEqual(['[main stdout] main: ready', `[window 1 opened] ${HOME}`, '[window 1 crashed]', '[main exited] code 0'])
  const entries = started.platformLog()
  expect(entries.map((entry) => entry.line)).toEqual(started.console())
  for (const entry of entries) expect(entry.at).toBeGreaterThanOrEqual(before)
})

test('a click that closes its own window has landed: the window going away under it is not the click failing (#223)', async () => {
  const events: string[] = []
  const main = fakeWindow(events, 'Greeter', HOME, ['button=Shared'])
  const details = fakeWindow(events, 'Details', 'file:///opt/app/resources/app/renderer/details.html', ['button=Close details', 'button=Broken'])
  const closed = 'locator.click: Target page, context or browser has been closed'
  // Over a relayed endpoint the window's close can overtake the click's own answer.
  const getByRole = details.page.getByRole as (role: string, options: { name: string }) => { click: () => Promise<unknown>; first: () => unknown }
  details.page.getByRole = (role: string, options: { name: string }) => {
    const locator = getByRole(role, options)
    locator.click = async () => {
      if (options.name === 'Close details') details.close()
      throw new Error(closed)
    }
    return locator
  }
  const { session } = harness({ windows: [main, details] })
  const started = await session()
  // The window is still open after this click, so its error is the click's own.
  await expect(started.page.click({ role: 'button', name: 'Broken' })).rejects.toThrow(closed)
  await started.page.click({ role: 'button', name: 'Close details' })
  // The flow carries on in the window that is left.
  await started.page.click({ role: 'button', name: 'Shared' })
  expect(events.filter((event) => event.startsWith('click'))).toEqual(['click button=Shared in Greeter'])
  await started.dispose()
})
