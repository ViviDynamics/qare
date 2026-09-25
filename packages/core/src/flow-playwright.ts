import type { EgressAttempt } from './egress.js'
import type { FlowElement, FlowPage, FlowTrace } from './flow.js'

const NOT_INSTALLED_MESSAGE =
  'playwright-core is not installed; flow checks are unverified without a browser backend'
const LOAD_FAILED_MESSAGE =
  'playwright-core failed to load; flow checks are unverified without a working backend'

type PlaywrightModule = typeof import('playwright-core')

export class PlaywrightFlowSessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlaywrightFlowSessionError'
  }
}

/**
 * A flow session backed by a real Playwright chromium: one browser, one context
 * and one page, all launched lazily on first use and shared by the page and
 * trace seams. dispose closes the browser.
 */
export async function makePlaywrightFlowSession(
  opts: {
    browserExecutablePath?: string
    loadPlaywright?: () => Promise<PlaywrightModule>
  } = {},
): Promise<{ page: FlowPage; trace: FlowTrace; dispose: () => Promise<void>; outbound: () => EgressAttempt[] }> {
  const loadPlaywright =
    opts.loadPlaywright ?? ((): Promise<PlaywrightModule> => import('playwright-core'))
  let playwright: PlaywrightModule
  try {
    playwright = await loadPlaywright()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ERR_MODULE_NOT_FOUND')
      throw new PlaywrightFlowSessionError(NOT_INSTALLED_MESSAGE, { cause: error })
    throw new PlaywrightFlowSessionError(LOAD_FAILED_MESSAGE, { cause: error })
  }
  const chromium = playwright.chromium

  type Browser = Awaited<ReturnType<typeof chromium.launch>>
  type Context = Awaited<ReturnType<Browser['newContext']>>
  type BrowserPage = Awaited<ReturnType<Context['newPage']>>

  let starting: Promise<{ browser: Browser; context: Context; page: BrowserPage }> | null = null
  // Every request the context makes, so a run against a target can hold the
  // hosts it reached against the ones its profile declares (#122).
  const outbound: EgressAttempt[] = []

  const start = (): Promise<{ browser: Browser; context: Context; page: BrowserPage }> => {
    starting ??= chromium
      .launch({ headless: true, executablePath: opts.browserExecutablePath })
      .then(async (browser) => {
        const context = await browser.newContext()
        const record = (url: string): void => {
          const attempt = attemptOf(url)
          if (attempt !== undefined) outbound.push(attempt)
        }
        context.on('request', (request) => record(request.url()))
        // A WebSocket never raises a request event, so every page the context
        // opens reports its own: the flow's page, and any popup it spawns.
        context.on('page', (opened) => opened.on('websocket', (socket) => record(socket.url())))
        const page = await context.newPage()
        return { browser, context, page }
      })
      .catch((error: unknown) => {
        // a failed start must not poison the cached promise: the next use retries
        starting = null
        throw error
      })
    return starting
  }

  // Elements are resolved against the page here, from the semantic reference
  // the plan carries (#70, #121): the model names a role with its accessible
  // name or a test id, never a selector, never coordinates.
  const resolve = (
    page: BrowserPage,
    element: FlowElement,
  ): ReturnType<BrowserPage['getByRole']> | ReturnType<BrowserPage['getByTestId']> =>
    'testId' in element
      ? page.getByTestId(element.testId)
      : page.getByRole(element.role as never, { name: element.name })

  const page: FlowPage = {
    open: async (url) => {
      const started = await start()
      await started.page.goto(url, { waitUntil: 'networkidle' })
    },
    click: async (element) => {
      const started = await start()
      await resolve(started.page, element).click()
    },
    type: async (element, value) => {
      const started = await start()
      await resolve(started.page, element).fill(value)
    },
    assertText: async (text) => {
      const started = await start()
      const locator = started.page.getByText(text).first()
      const visible = await locator.isVisible()
      if (!visible) {
        throw new Error(`assert failed: the text ${JSON.stringify(text)} is not visible`)
      }
    },
    screenshot: async (path) => {
      const started = await start()
      await started.page.screenshot({ path })
    },
  }

  const trace: FlowTrace = {
    start: async () => {
      const started = await start()
      await started.context.tracing.start({ screenshots: true, snapshots: true })
      return 'playwright-trace'
    },
    stop: async (path) => {
      const started = await start()
      await started.context.tracing.stop({ path })
    },
  }

  const dispose = async (): Promise<void> => {
    if (starting === null) return
    const pending = starting
    starting = null
    const started = await pending
    await started.browser.close()
  }

  return { page, trace, dispose, outbound: () => [...outbound] }
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 }

/** A request that leaves the browser, as a connection attempt; `data:` and `blob:` URLs never do. */
export function attemptOf(url: string): EgressAttempt | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const defaultPort = DEFAULT_PORTS[parsed.protocol]
  if (defaultPort === undefined) return undefined
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? defaultPort : Number(parsed.port),
    protocol: parsed.protocol.slice(0, -1),
  }
}
