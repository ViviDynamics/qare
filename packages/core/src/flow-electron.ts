import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { CellRecord, ClientCell } from './client-cell.js'
import { describeElement, type FlowDriverCapabilities, type FlowElement, type FlowPage, type FlowTrace } from './flow.js'
import { captureMasks, followPage, resolveFlowElement, takeFrame } from './flow-playwright.js'
import { MAX_PLATFORM_LOG_LINE_CHARACTERS as MAX_LINE_CHARACTERS, makePlatformLog, type PlatformLogEntry } from './platform-log.js'
import { pathOnTarget } from './profile.js'
import { normaliseAriaSnapshot } from './snapshot.js'

/**
 * The Electron driver's own declaration (#72). A desktop shell is a browser
 * in a window, so it declares the browser's whole vocabulary and a flow moves
 * across with no edit beyond the target. Its evidence is the browser's, plus
 * the application's own console output. What it cannot do is declared rather
 * than found out: it serves no `visual` and no `a11y` check, because both
 * resize and re-theme a viewport, and a desktop window is not one.
 */
export const ELECTRON_FLOW_DRIVER: FlowDriverCapabilities = {
  name: 'electron',
  actions: ['open', 'type', 'click', 'choose', 'waitFor', 'assertText', 'assertElement', 'capture', 'totp', 'backupCode'],
  evidence: ['screenshot', 'trace', 'console', 'recording'],
  checks: [],
}

type PlaywrightModule = typeof import('playwright-core')
type Page = import('playwright-core').Page
type Locator = import('playwright-core').Locator

const NOT_INSTALLED_MESSAGE = 'playwright-core is not installed; the electron driver attaches to the application through it, so its flow checks are unverified without it'
const LOAD_FAILED_MESSAGE = 'playwright-core failed to load; the electron driver attaches to the application through it, so its flow checks are unverified without it'

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000
/** How long an element is looked for across the windows; Playwright's own action timeout. */
const DEFAULT_FIND_TIMEOUT_MS = 30_000
const DEFAULT_POLL_INTERVAL_MS = 100
const DEFAULT_CLOSE_GRACE_MS = 5_000
/** How much of the output a failed start quotes in its reason. */
const FAILURE_OUTPUT_LINES = 20

/** The line Chromium prints when the driver's own flag opens the endpoint: the driver's doing, not the application's. */
const ENDPOINT_LINE = /^DevTools listening on (ws:\/\/\S+)$/

export class ElectronFlowSessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ElectronFlowSessionError'
  }
}

/** The part of a child process the driver uses, so a test can stand one in. */
export interface ElectronAppProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

/** The host a desktop build is launched on, as far as showing a window goes (#72). */
export interface ElectronHost {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Where the host's Xvfb is, when it has one; looked up on PATH by default. */
  xvfb?: () => string | undefined
}

/** Whether Linux has a display for a window to open on. */
function hasDisplay(env: NodeJS.ProcessEnv): boolean {
  return (env.DISPLAY ?? '') !== '' || (env.WAYLAND_DISPLAY ?? '') !== ''
}

export function xvfbOnPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, 'Xvfb')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not in this directory.
    }
  }
  return undefined
}

/**
 * Why a desktop window cannot be shown here, or undefined when it can (#72).
 * Only Linux names its display in the environment; the other platforms have
 * a session or they do not, which the launch itself reports. A Linux host
 * with no display still has one when it carries Xvfb, because the driver
 * starts a virtual display for each launch.
 */
export function electronDisplayProblem(host: ElectronHost = {}): string | undefined {
  const env = host.env ?? process.env
  if ((host.platform ?? process.platform) !== 'linux' || hasDisplay(env)) return undefined
  if ((host.xvfb ?? ((): string | undefined => xvfbOnPath(env)))() !== undefined) return undefined
  return 'the electron driver needs a display: neither DISPLAY nor WAYLAND_DISPLAY is set, and no Xvfb is on PATH to start a virtual one (the web image ships it)'
}

/** What a window needs from the environment to open, beside PATH and HOME. */
const DISPLAY_VARIABLES = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']

/** The minimal deterministic environment a command step gets on a host (#91), with the display a desktop build needs. */
function minimalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const minimal: NodeJS.ProcessEnv = { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? '' }
  for (const name of DISPLAY_VARIABLES) {
    const value = env[name]
    if (value !== undefined && value !== '') minimal[name] = value
  }
  return minimal
}

/** How long Xvfb is given to say which display it took. */
const DISPLAY_START_TIMEOUT_MS = 10_000

/**
 * Start a virtual display for one launch (#72): an Xvfb that picks a free
 * display number itself and writes it to the descriptor it is handed, so two
 * launches on one host never share a display. `stop` ends it.
 */
export function startVirtualDisplay(xvfb: string): Promise<{ display: string; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(xvfb, ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    let settled = false
    let stderr = ''
    let number = ''
    const gone = new Promise<void>((done) => child.on('exit', () => done()))
    const fail = (why: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(new ElectronFlowSessionError(`the virtual display did not start: ${why}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`))
    }
    const timer = setTimeout(() => fail(`${xvfb} named no display within ${DISPLAY_START_TIMEOUT_MS} ms`), DISPLAY_START_TIMEOUT_MS)
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000)
    })
    child.stdio[3]?.on('data', (chunk) => {
      number += String(chunk)
      if (settled || !number.includes('\n')) return
      settled = true
      clearTimeout(timer)
      resolve({
        display: `:${number.trim()}`,
        stop: async () => {
          child.kill('SIGTERM')
          await gone
        },
      })
    })
    child.on('error', (error) => fail(`${xvfb} could not be started (${error.message})`))
    child.on('exit', (code, signal) => fail(`${xvfb} exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}`))
  })
}

/**
 * Why an `open` URL is not one the driver can open, or undefined when it is
 * (#72). A desktop shell has no address bar: a flow opens a path inside the
 * application, and a full URL would point a window of the application at a
 * page it never shipped.
 */
export function applicationPathProblem(url: string): string | undefined {
  if (!url.startsWith('/')) return `the electron driver opens a path inside the application, not ${JSON.stringify(url)}: a desktop shell has no address bar, so write a path such as "/"`
  if (pathOnTarget('app://application/', url) === undefined) return `the path ${JSON.stringify(url)} climbs out of the application; a path inside it stays below the page its first window loaded`
  return undefined
}

/**
 * A path inside the application, as the URL a window is sent to (#72). `/`
 * is the page the application's first window loaded; any other path resolves
 * beside that page, the way a path on a target resolves below its URL.
 */
export function pathInApplication(home: string, path: string): string {
  const problem = applicationPathProblem(path)
  if (problem !== undefined) throw new Error(problem)
  if (path === '/') return home
  const resolved = pathOnTarget(new URL('.', home).href, path)
  if (resolved === undefined) throw new Error(`the path ${JSON.stringify(path)} climbs out of the application; a path inside it stays below the page its first window loaded`)
  return resolved
}

interface AppWindow {
  id: number
  page: Page
}

/**
 * A flow session against a packaged Electron application (#72). The driver
 * starts the build itself and attaches to it over the DevTools endpoint the
 * build opens, so the application's output is read from its first byte and
 * its windows are ordinary Playwright pages: the same locators, screenshots,
 * snapshot and trace the browser driver uses.
 *
 * Every launch gets a user data directory of its own, removed when the
 * session is disposed, so one check's state never explains another's.
 *
 * An application has windows where a browser flow has one page. The
 * vocabulary names no window, so an element reference is looked for in every
 * open window, newest first, and the window that shows it becomes the one
 * the next screenshot and snapshot are taken of. A flow written for one page
 * therefore runs unchanged, and one that opens a second window follows it
 * there and comes back when it closes.
 */
export async function makeElectronFlowSession(opts: {
  /** The build to launch, as an absolute path. */
  executable: string
  /** The profile's own arguments; the driver adds the endpoint and the user data directory after them. */
  args?: readonly string[]
  masks?: string[]
  loadPlaywright?: () => Promise<PlaywrightModule>
  /** Starts the build; `env` is the environment it is launched into, with the display it opens on. */
  spawnApp?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ElectronAppProcess
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  xvfb?: () => string | undefined
  /**
   * What the build is launched with. `inherit` (the default) hands it the
   * harness environment, which inside an image the image controls. `minimal`
   * hands it PATH, HOME and what a window needs to open, and nothing else:
   * the build is pull request code, and on a host it never inherits the
   * host's tokens (#91).
   */
  environment?: 'inherit' | 'minimal'
  /** Starts the virtual display a host with none gets; an Xvfb by default. */
  startDisplay?: (xvfb: string) => Promise<{ display: string; stop: () => Promise<void> }>
  /**
   * Makes the cell the build is launched in (#223, ADR-0006): a container
   * with no network, whose gate records what the build reaches for. With a
   * cell the build is never started beside the run: the cell brings its own
   * display, its own user data directory, and the port the build listens
   * on. Without one the build runs with the network its step has, and the
   * session reports nothing about what it reached.
   */
  cell?: () => Promise<ClientCell>
  launchTimeoutMs?: number
  findTimeoutMs?: number
  pollIntervalMs?: number
  closeGraceMs?: number
}): Promise<{
  capabilities: FlowDriverCapabilities
  page: FlowPage
  trace: FlowTrace
  dispose: () => Promise<void>
  /** Everything the application wrote and every window it opened or closed, in order. */
  console: () => string[]
  /** The same lines, each with the moment it was written (#78). */
  platformLog: () => PlatformLogEntry[]
  /** What the build reached for, as its cell's gate recorded it (#223). Only with a cell, and only once disposed. */
  reached?: () => CellRecord
}> {
  const launchTimeoutMs = opts.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
  const findTimeoutMs = opts.findTimeoutMs ?? DEFAULT_FIND_TIMEOUT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS

  let playwright: PlaywrightModule
  try {
    playwright = await (opts.loadPlaywright ?? ((): Promise<PlaywrightModule> => import('playwright-core')))()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    throw new ElectronFlowSessionError(code === 'ERR_MODULE_NOT_FOUND' ? NOT_INSTALLED_MESSAGE : LOAD_FAILED_MESSAGE, { cause: error })
  }
  const host: ElectronHost = { ...(opts.env === undefined ? {} : { env: opts.env }), ...(opts.platform === undefined ? {} : { platform: opts.platform }), ...(opts.xvfb === undefined ? {} : { xvfb: opts.xvfb }) }
  // A contained build's display is its cell's, so this host's is not asked about.
  const displayProblem = opts.cell === undefined ? electronDisplayProblem(host) : undefined
  if (displayProblem !== undefined) throw new ElectronFlowSessionError(displayProblem)
  let cell: ClientCell | undefined
  if (opts.cell !== undefined) {
    try {
      cell = await opts.cell()
    } catch (error) {
      throw new ElectronFlowSessionError((error as Error).message, { cause: error })
    }
  }
  // A Linux host with no display gets a virtual one for this launch alone,
  // stopped when the session is: the application opens real windows, and
  // nothing else on the host has to have started a display for it.
  const hostEnv = opts.env ?? process.env
  let virtual: { display: string; stop: () => Promise<void> } | undefined
  if (cell === undefined && (opts.platform ?? process.platform) === 'linux' && !hasDisplay(hostEnv)) {
    const xvfb = (opts.xvfb ?? ((): string | undefined => xvfbOnPath(hostEnv)))()
    if (xvfb !== undefined) virtual = await (opts.startDisplay ?? startVirtualDisplay)(xvfb)
  }
  const appEnv: NodeJS.ProcessEnv = {
    ...(opts.environment === 'minimal' ? minimalEnvironment(hostEnv) : { ...process.env, ...opts.env }),
    ...(virtual === undefined ? {} : { DISPLAY: virtual.display }),
  }

  // The application's own output and its windows' lifecycle, in the order
  // they happened. Bounded, so a build that logs in a loop cannot grow the
  // run without limit; what was dropped is counted.
  const platform = makePlatformLog()
  const record = platform.record
  const output = platform.lines

  // Inside a cell the directory is the cell's own and goes with it, and the
  // port is the one the cell relays: nothing else is in that namespace.
  const userDataDir = cell?.userDataDir ?? (await mkdtemp(join(tmpdir(), 'qare-electron-')))
  const removeUserData = async (): Promise<void> => {
    if (cell === undefined) await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
  const spawnApp =
    opts.spawnApp ?? ((command: string, args: string[], env: NodeJS.ProcessEnv): ElectronAppProcess => spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env }))
  const launchArgs = [...(opts.args ?? []), `--remote-debugging-port=${cell?.debuggingPort ?? 0}`, `--user-data-dir=${userDataDir}`]
  let child: ElectronAppProcess
  try {
    child = cell === undefined ? spawnApp(opts.executable, launchArgs, appEnv) : cell.spawn(opts.executable, launchArgs)
  } catch (error) {
    await virtual?.stop().catch(() => {})
    await removeUserData()
    await cell?.dispose().catch(() => {})
    throw new ElectronFlowSessionError(`the application at ${opts.executable} could not be started: ${String(error)}`, { cause: error })
  }

  let exit: string | undefined
  let onEndpoint: ((endpoint: string) => void) | undefined
  let onExit: (() => void) | undefined
  const exited = new Promise<void>((resolve) => {
    onExit = resolve
  })
  // Each stream is read by line: a chunk ends where the pipe says, not where
  // a line does, and a log of half lines reads as nothing.
  const flushers: Array<() => void> = []
  const follow = (stream: ElectronAppProcess['stdout'], label: string): void => {
    let partial = ''
    // A line that outgrew its bound has been recorded cut; what follows it,
    // up to the line's end, is the rest of that line and is dropped.
    let overflowed = false
    const emit = (line: string): void => {
      const text = line.replace(/\r$/, '')
      if (text === '') return
      const endpoint = ENDPOINT_LINE.exec(text)
      if (endpoint !== null) {
        onEndpoint?.(endpoint[1] as string)
        return
      }
      record(label, text)
    }
    stream?.on('data', (chunk) => {
      const parts = (partial + String(chunk)).split('\n')
      partial = parts.pop() ?? ''
      for (const [index, part] of parts.entries()) {
        // The first part ends the line that was already cut.
        if (index === 0 && overflowed) overflowed = false
        else emit(part)
      }
      if (overflowed) partial = ''
      else if (partial.length > MAX_LINE_CHARACTERS) {
        emit(partial)
        partial = ''
        overflowed = true
      }
    })
    flushers.push(() => {
      if (partial !== '') emit(partial)
      partial = ''
    })
  }
  follow(child.stdout, 'main stdout')
  follow(child.stderr, 'main stderr')
  const settle = (how: string): void => {
    if (exit !== undefined) return
    for (const flush of flushers) flush()
    exit = how
    record('main exited', how)
    onExit?.()
  }
  child.on('exit', (code, signal) => settle(code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`))
  child.on('error', (error) => settle(`could not be started: ${error.message}`))

  const waitFor = (done: Promise<unknown>, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      void done.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })

  type Browser = Awaited<ReturnType<PlaywrightModule['chromium']['connectOverCDP']>>
  let browser: Browser | undefined
  // A harness that exits with the session still open (a canceled run) must
  // not leave the application or its display running behind it: there is no
  // time to ask, so both are ended outright.
  const reap = (): void => {
    if (exit === undefined) child.kill('SIGKILL')
    void virtual?.stop().catch(() => {})
    cell?.reap()
  }
  process.once('exit', reap)
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    process.off('exit', reap)
    // Closing is the application's to do: it is asked, given a grace, and
    // only then killed, so what it writes on the way out is still read.
    if (exit === undefined) {
      child.kill('SIGTERM')
      if (!(await waitFor(exited, closeGraceMs))) {
        child.kill('SIGKILL')
        await waitFor(exited, closeGraceMs)
      }
    }
    await browser?.close().catch(() => {})
    await virtual?.stop().catch(() => {})
    await removeUserData()
    // The cell last: its gate writes the record once the build is gone.
    await cell?.dispose().catch(() => {})
  }
  const failStart = async (message: string): Promise<never> => {
    await dispose()
    const tail = output().slice(-FAILURE_OUTPUT_LINES).join('\n')
    throw new ElectronFlowSessionError(tail === '' ? message : `${message}; its output: ${tail}`)
  }

  const endpoint = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), launchTimeoutMs)
    onEndpoint = (found) => {
      clearTimeout(timer)
      resolve(found)
    }
    void exited.then(() => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
  if (endpoint === undefined) {
    if (exit !== undefined) return failStart(`the application exited with ${exit} before the driver could attach`)
    return failStart(
      `the application opened no DevTools endpoint within ${launchTimeoutMs} ms: the electron driver attaches over the one --remote-debugging-port opens, and a build that turns remote debugging off cannot be driven`,
    )
  }

  const windows: AppWindow[] = []
  const attach = (page: Page): void => {
    if (windows.some((window) => window.page === page)) return
    const window = { id: windows.length + 1, page }
    windows.push(window)
    followPage(page, `window ${window.id}`, record)
  }
  let context: ReturnType<Browser['contexts']>[number]
  try {
    browser = await playwright.chromium.connectOverCDP(cell === undefined ? endpoint : cell.endpoint(endpoint))
    const [first] = browser.contexts()
    if (first === undefined) return await failStart('the application exposes no browser context to attach to')
    context = first
    for (const page of context.pages()) attach(page)
    context.on('page', attach)
  } catch (error) {
    if (error instanceof ElectronFlowSessionError) throw error
    return failStart(`the driver could not attach to the application: ${String(error)}`)
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const open = (): AppWindow[] => windows.filter((window) => !window.page.isClosed())
  const newestFirst = (): AppWindow[] => open().reverse()

  const opening = Date.now() + launchTimeoutMs
  while (open().length === 0) {
    if (exit !== undefined) return failStart(`the application exited with ${exit} before it opened a window`)
    if (Date.now() >= opening) return failStart(`the application opened no window within ${launchTimeoutMs} ms`)
    await sleep(pollIntervalMs)
  }
  // The page the first window loaded is where the application starts: `/`.
  const firstWindow = open()[0] as AppWindow
  await firstWindow.page.waitForLoadState('load').catch(() => {})
  const home = firstWindow.page.url()

  let current: AppWindow | undefined = firstWindow
  const currentPage = (): Page => {
    const window = current !== undefined && !current.page.isClosed() ? current : newestFirst()[0]
    if (window === undefined) throw new Error('the application has no window open')
    current = window
    return window.page
  }
  const describeWindows = async (): Promise<string> => {
    const named = await Promise.all(open().map(async (window) => `${window.id} ${JSON.stringify(await window.page.title().catch(() => ''))}`))
    return named.length === 0 ? 'no window is open' : `open windows: ${named.join(', ')}`
  }
  // Whether a window shows what a locator names. A window that goes away
  // while it is asked answers with an error, and a window that is gone shows
  // nothing: it is passed over, never read as the application's fault.
  const shows = async (window: AppWindow, locate: (page: Page) => Locator): Promise<boolean> => {
    try {
      return await locate(window.page).isVisible()
    } catch {
      return false
    }
  }
  // The window an action lands in: the newest one that shows the element.
  // A window that is still opening is waited for, like an element that is
  // still rendering, until the time an action is given runs out.
  const windowShowing = async (what: string, locate: (page: Page) => Locator): Promise<Page> => {
    const deadline = Date.now() + findTimeoutMs
    for (;;) {
      for (const window of newestFirst()) {
        if (await shows(window, (page) => locate(page).first())) {
          current = window
          return window.page
        }
      }
      if (Date.now() >= deadline) throw new Error(`no open window shows ${what} within ${findTimeoutMs} ms (${await describeWindows()})`)
      await sleep(pollIntervalMs)
    }
  }
  const acting = (element: FlowElement): Promise<Locator> =>
    windowShowing(describeElement(element), (page) => resolveFlowElement(page, element)).then((page) => resolveFlowElement(page, element))

  const page: FlowPage = {
    open: async (url) => {
      await currentPage().goto(pathInApplication(home, url), { waitUntil: 'networkidle' })
    },
    click: async (element) => {
      const locator = await acting(element)
      const clicked = current
      try {
        await locator.click()
      } catch (error) {
        // A click that closes its own window has landed (#223). The window
        // going away can overtake the click's own answer, the more so over a
        // relayed endpoint, and Playwright then reports the page as closed.
        // The click was only attempted because the window showed the
        // element, so a window that is gone afterwards is what the click
        // did; any other error, or the same one with the window still open,
        // is the click failing.
        if (clicked?.page.isClosed() === true && /has been closed/.test((error as Error).message)) return
        throw error
      }
    },
    type: async (element, value) => {
      await (await acting(element)).fill(value)
    },
    choose: async (element, value) => {
      await (await acting(element)).selectOption({ label: value })
    },
    waitFor: async (element) => {
      await acting(element)
    },
    // An assertion is the application as it stands: every open window is
    // asked once, and nothing is waited for.
    assertText: async (text) => {
      for (const window of newestFirst()) {
        if (await shows(window, (page) => page.getByText(text).first())) {
          current = window
          return
        }
      }
      throw new Error(`assert failed: the text ${JSON.stringify(text)} is not visible in any open window`)
    },
    assertElement: async (element) => {
      for (const window of newestFirst()) {
        if (await shows(window, (page) => resolveFlowElement(page, element))) {
          current = window
          return
        }
      }
      throw new Error('assert failed: the element is not visible in any open window')
    },
    screenshot: async (path, capture) => {
      const shown = currentPage()
      // Masks black out their regions at capture, as in the browser (#119).
      await shown.screenshot({ path, ...captureMasks(shown, opts.masks, capture) })
    },
    // A frame of the recording is the window the flow is in (#78), masked as
    // its screenshot is; over a cell's relayed endpoint it is one more call.
    frame: async (capture) => takeFrame(currentPage(), opts.masks, capture),
    snapshot: async () => normaliseAriaSnapshot(await currentPage().ariaSnapshot()),
  }

  const trace: FlowTrace = {
    start: async () => {
      await context.tracing.start({ screenshots: true, snapshots: true })
      return 'playwright-trace'
    },
    stop: async (path) => {
      await context.tracing.stop({ path })
    },
  }

  const contained = cell
  return {
    capabilities: ELECTRON_FLOW_DRIVER,
    page,
    trace,
    dispose,
    console: output,
    platformLog: platform.entries,
    ...(contained === undefined ? {} : { reached: (): CellRecord => contained.record() }),
  }
}
