import type { EgressAttempt } from './egress.js'
import type { FlowCaptureOpts, FlowDriverCapabilities, FlowElement, FlowPage, FlowTrace } from './flow.js'
import { RECORDING_FRAME_TIMEOUT_MS } from './flow-recording.js'
import { parseSegment, splitSegments } from './locator.js'
import type { A11yAuditNode, A11yAuditViolation } from './a11y.js'
import { makePlatformLog, type PlatformLogEntry } from './platform-log.js'
import { normaliseAriaSnapshot, type SnapshotNode } from './snapshot.js'

const NOT_INSTALLED_MESSAGE =
  'playwright-core is not installed; flow checks are unverified without a browser backend'
const LOAD_FAILED_MESSAGE =
  'playwright-core failed to load; flow checks are unverified without a working backend'

/**
 * The browser driver's own declaration (#70): the actions its seam can perform
 * and the evidence kinds it can produce. A plan naming anything else is
 * rejected before anything runs, so the declaration is the contract a flow is
 * written against, and a swapped driver that declares the same set runs the
 * same flow unchanged.
 */
export const BROWSER_FLOW_DRIVER: FlowDriverCapabilities = {
  name: 'browser',
  actions: ['open', 'type', 'click', 'choose', 'waitFor', 'assertText', 'assertElement', 'capture', 'totp', 'backupCode'],
  evidence: ['screenshot', 'trace', 'console', 'recording'],
  checks: ['visual', 'a11y'],
}

type PlaywrightModule = typeof import('playwright-core')

const AXE_NOT_INSTALLED_MESSAGE = 'axe-core is not installed; accessibility checks are unverified without the rule engine'
const AXE_LOAD_FAILED_MESSAGE = 'axe-core failed to load; accessibility checks are unverified without the rule engine'

/** The height an audit resizes to when the page reports no viewport of its own. */
const DEFAULT_VIEWPORT_HEIGHT = 720
/** How many violating elements one audit names from the snapshot; the rest are reported by selector. */
const MAX_NAMED_ELEMENTS = 50
/** The accessible name an element wears for the one snapshot that finds its node. */
const MARKER_PREFIX = 'qare-a11y-marker-'

async function loadAxeCore(): Promise<{ source: string }> {
  const loaded = (await import('axe-core')) as unknown as { source?: string; default?: { source?: string } }
  const source = loaded.source ?? loaded.default?.source
  if (typeof source !== 'string') throw new Error('axe-core exports no source to run in the page')
  return { source }
}

/** What `runAxeInPage` hands back: the engine's violations, flattened to what crosses the page boundary. */
interface RawAudit {
  version: string
  incomplete: number
  violations: Array<{
    id: string
    impact?: string | null
    help: string
    helpUrl?: string
    /** `selector` is carried only for an element of the page itself, which the snapshot can be asked about. */
    nodes: Array<{ target: string; selector?: string }>
  }>
}

/**
 * Run the rule engine in the page (#149). This function is serialised and
 * evaluated in the browser, so it reads only the page's own globals and
 * closes over nothing. A frame or a shadow root makes a target several
 * selectors deep: it is reported joined, with no selector to resolve.
 */
export async function runAxeInPage(request: { tags: string[] }): Promise<RawAudit> {
  const page = globalThis as unknown as {
    axe: {
      version: string
      run: (
        context: unknown,
        options: unknown,
      ) => Promise<{
        violations: Array<{ id: string; impact?: string | null; help: string; helpUrl?: string; nodes: Array<{ target: Array<string | string[]> }> }>
        incomplete: unknown[]
      }>
    }
    document: unknown
    requestAnimationFrame: (done: () => void) => void
  }
  // Two frames, so a viewport or colour scheme that just changed has been laid out.
  await new Promise<void>((resolve) => page.requestAnimationFrame(() => page.requestAnimationFrame(() => resolve())))
  const result = await page.axe.run(page.document, { runOnly: { type: 'tag', values: request.tags }, resultTypes: ['violations', 'incomplete'] })
  return {
    version: page.axe.version,
    incomplete: result.incomplete.length,
    violations: result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      helpUrl: violation.helpUrl,
      nodes: violation.nodes.map((node) => {
        const only = node.target.length === 1 ? node.target[0] : undefined
        const target = node.target.map((part) => (Array.isArray(part) ? part.join(' ') : part)).join(' ')
        return typeof only === 'string' ? { target, selector: only } : { target }
      }),
    })),
  }
}

interface MarkableElement {
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
}

type MarkablePage = { document: { querySelector: (selector: string) => MarkableElement | null } }

/** Evaluated in the page: give each element its marker for an accessible name, and answer what it carried before. */
export function markInPage(marks: Array<{ selector: string; marker: string }>): Array<string | null> {
  const page = globalThis as unknown as MarkablePage
  return marks.map((mark) => {
    const element = page.document.querySelector(mark.selector)
    if (element === null) return null
    const previous = element.getAttribute('aria-label')
    element.setAttribute('aria-label', mark.marker)
    return previous
  })
}

/** Evaluated in the page: put back what `markInPage` replaced. */
export function unmarkInPage(marks: Array<{ selector: string; previous: string | null }>): void {
  const page = globalThis as unknown as MarkablePage
  for (const mark of marks) {
    const element = page.document.querySelector(mark.selector)
    if (element === null) continue
    if (mark.previous === null) element.removeAttribute('aria-label')
    else element.setAttribute('aria-label', mark.previous)
  }
}

type PlaywrightPage = import('playwright-core').Page
type PlaywrightLocator = import('playwright-core').Locator

// Elements are resolved against the page here, from the semantic reference
// the plan carries (#70, #121): the model names a role with its accessible
// name or a test id, never a selector, never coordinates. A reference that
// carries a snapshot path (#83) resolves by walking the path itself: each
// step names a role, an optional accessible name and an optional occurrence
// index, so the walk lands on the element the snapshot named.
function resolveStep(parent: PlaywrightPage | PlaywrightLocator, step: string): PlaywrightLocator {
  const parsed = parseSegment(step)
  if (parsed === undefined)
    throw new Error(`a snapshot path step is a role, an optional quoted accessible name and an optional occurrence index: ${step}`)
  const locator = parent.getByRole(parsed.role as never, parsed.name === undefined ? {} : { name: parsed.name, exact: true })
  return parsed.occurrence === undefined ? locator : locator.nth(parsed.occurrence - 1)
}

/**
 * One element reference, resolved against one page. Every driver that drives
 * a Chromium page through Playwright resolves a reference the same way, so a
 * flow means the same element in the browser and in a desktop window (#72).
 */
export function resolveFlowElement(page: PlaywrightPage, element: FlowElement): PlaywrightLocator {
  if ('testId' in element) return page.getByTestId(element.testId)
  if (element.at === undefined) return page.getByRole(element.role as never, { name: element.name })
  // The path's own root step is the document, which is the page the walk
  // starts from; the steps below it chain one into the next.
  const [first, ...rest] = splitSegments(element.at).slice(1)
  if (first === undefined) return page.getByRole(element.role as never, { name: element.name })
  let chain = resolveStep(page, first)
  for (const step of rest) chain = resolveStep(chain, step)
  return chain
}

/**
 * What a capture of one page blacks out (#119, #78): the profile's masks,
 * and every element the flow concealed because a secret was typed into it.
 * The browser paints them over while it takes the picture, so the pixels on
 * disk never held what they cover. Nothing to hide asks for no mask at all.
 */
export function captureMasks(page: PlaywrightPage, masks: readonly string[] | undefined, capture: FlowCaptureOpts | undefined): { mask?: PlaywrightLocator[]; maskColor?: string } {
  const mask = [...(masks ?? []).map((selector) => page.locator(selector)), ...(capture?.conceal ?? []).map((element) => resolveFlowElement(page, element))]
  return mask.length === 0 ? {} : { mask, maskColor: '#000000' }
}

/**
 * One frame of a recording (#78): a screenshot kept in memory, at the size
 * the page is laid out at, masked as a screenshot is, and given a bounded
 * time so a page that cannot be pictured costs the flow one frame.
 */
export async function takeFrame(page: PlaywrightPage, masks: readonly string[] | undefined, capture: FlowCaptureOpts | undefined): Promise<Uint8Array> {
  return page.screenshot({ type: 'png', scale: 'css', timeout: RECORDING_FRAME_TIMEOUT_MS, ...captureMasks(page, masks, capture) })
}

/**
 * Follow one page into the platform log (#72, #78): that it opened, what it
 * wrote to its console, the errors it raised, and that it crashed or closed.
 */
export function followPage(page: PlaywrightPage, label: string, record: (label: string, text?: string) => void): void {
  record(`${label} opened`, page.url())
  page.on('console', (message) => record(`${label} console.${message.type()}`, message.text()))
  page.on('pageerror', (error) => record(`${label} error`, error.message))
  // A renderer that died is the crash report a reader gets: the dump itself
  // is a memory image nothing can sweep, and is never published.
  page.on('crash', () => record(`${label} crashed`))
  page.on('close', () => record(`${label} closed`))
}

export class PlaywrightFlowSessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlaywrightFlowSessionError'
  }
}

/**
 * A flow session backed by a real Playwright chromium: one browser, one context
 * and one page, all launched lazily on first use and shared by the page and
 * trace seams. dispose closes the browser. The profile's masks (#119) black out
 * their page regions while the browser takes a screenshot, so fixture data
 * never reaches the pixels; they apply to every capture the session takes.
 */
export async function makePlaywrightFlowSession(
  opts: {
    browserExecutablePath?: string
    loadPlaywright?: () => Promise<PlaywrightModule>
    /** Where the accessibility rule engine's source comes from (#149); axe-core by default. */
    loadAxe?: () => Promise<{ source: string }>
    masks?: string[]
  } = {},
): Promise<{
  capabilities: FlowDriverCapabilities
  page: FlowPage
  trace: FlowTrace
  dispose: () => Promise<void>
  outbound: () => EgressAttempt[]
  /** What the pages wrote and what became of them, in order (#78). */
  console: () => string[]
  /** The same lines, each with the moment it was written. */
  platformLog: () => PlatformLogEntry[]
}> {
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
  // What every page of the context wrote (#78), bounded like a desktop
  // application's output: the page is pull request code too.
  const platform = makePlatformLog()
  let pages = 0

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
        context.on('page', (opened) => {
          opened.on('websocket', (socket) => record(socket.url()))
          pages += 1
          followPage(opened, `page ${pages}`, platform.record)
        })
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

  const page: FlowPage = {
    open: async (url) => {
      const started = await start()
      await started.page.goto(url, { waitUntil: 'networkidle' })
    },
    click: async (element) => {
      const started = await start()
      await resolveFlowElement(started.page, element).click()
    },
    type: async (element, value) => {
      const started = await start()
      await resolveFlowElement(started.page, element).fill(value)
    },
    choose: async (element, value) => {
      const started = await start()
      // The option is chosen by its accessible name, the same semantic form
      // the element reference itself carries (#70).
      await resolveFlowElement(started.page, element).selectOption({ label: value })
    },
    waitFor: async (element) => {
      const started = await start()
      await resolveFlowElement(started.page, element).waitFor({ state: 'visible' })
    },
    assertText: async (text) => {
      const started = await start()
      const locator = started.page.getByText(text).first()
      const visible = await locator.isVisible()
      if (!visible) {
        throw new Error(`assert failed: the text ${JSON.stringify(text)} is not visible`)
      }
    },
    assertElement: async (element) => {
      const started = await start()
      const visible = await resolveFlowElement(started.page, element).isVisible()
      if (!visible) {
        throw new Error(`assert failed: the element is not visible`)
      }
    },
    screenshot: async (path, capture) => {
      const started = await start()
      // Masks black out their regions at capture, in the browser (#119): the
      // screenshot on disk never carries the pixels the profile redacts away.
      await started.page.screenshot({ path, ...captureMasks(started.page, opts.masks, capture) })
    },
    frame: async (capture) => {
      const started = await start()
      return takeFrame(started.page, opts.masks, capture)
    },
    // The browser driver's mapping into the normalised schema (#82): the page's
    // ARIA snapshot, turned into nodes whose roles come from Core-AAM and whose
    // paths carry no generated ids.
    snapshot: async () => {
      const started = await start()
      return normaliseAriaSnapshot(await started.page.ariaSnapshot())
    },
    // The accessibility audit (#149): axe-core runs in the page as the flow
    // left it, at the width and colour scheme asked for, and the viewport is
    // put back afterwards so the flow carries on where it was. The engine's
    // source is evaluated into the page, never fetched by it, so the audit
    // reaches no host and a page's content policy does not stop it.
    audit: async (request) => {
      const started = await start()
      const source = await axeSource()
      const browserPage = started.page
      const before = browserPage.viewportSize()
      const resized = request.width !== undefined && before?.width !== request.width
      try {
        if (resized) await browserPage.setViewportSize({ width: request.width as number, height: before?.height ?? DEFAULT_VIEWPORT_HEIGHT })
        await browserPage.emulateMedia({ colorScheme: request.theme === 'dark' ? 'dark' : 'light' })
        await browserPage.evaluate(source)
        const raw = await browserPage.evaluate(runAxeInPage, { tags: [...request.tags] })
        const name = await elementNamer(browserPage, raw)
        const violations: A11yAuditViolation[] = []
        for (const violation of raw.violations) {
          const nodes: A11yAuditNode[] = violation.nodes.map((node) => ({ target: node.target, ...name(node.selector) }))
          violations.push({
            rule: violation.id,
            ...(typeof violation.impact === 'string' ? { impact: violation.impact } : {}),
            help: violation.help,
            ...(typeof violation.helpUrl === 'string' ? { helpUrl: violation.helpUrl } : {}),
            nodes,
          })
        }
        // The page is only pictured when there is something on it to look at.
        let screenshot = false
        if (request.screenshot !== undefined && violations.length > 0) {
          await browserPage.screenshot({
            path: request.screenshot,
            fullPage: true,
            ...(opts.masks === undefined || opts.masks.length === 0
              ? {}
              : { mask: opts.masks.map((selector) => browserPage.locator(selector)), maskColor: '#000000' }),
          })
          screenshot = true
        }
        return {
          url: browserPage.url(),
          width: browserPage.viewportSize()?.width ?? request.width ?? 0,
          theme: request.theme,
          engine: { name: 'axe-core', version: raw.version },
          violations,
          incomplete: raw.incomplete,
          ...(screenshot ? { screenshot } : {}),
        }
      } finally {
        await browserPage.emulateMedia({ colorScheme: null }).catch(() => {})
        if (resized && before !== null) await browserPage.setViewportSize(before).catch(() => {})
      }
    },
  }

  // The rule engine's source, loaded once per session. It is an optional
  // dependency like the browser itself: without it an audit names what is
  // missing, and the check is unverified rather than quietly clean.
  let axe: Promise<string> | null = null
  const axeSource = (): Promise<string> => {
    axe ??= (opts.loadAxe ?? loadAxeCore)().then(
      (loaded) => loaded.source,
      (error: unknown) => {
        axe = null
        const code = (error as NodeJS.ErrnoException | null)?.code
        throw new PlaywrightFlowSessionError(code === 'ERR_MODULE_NOT_FOUND' ? AXE_NOT_INSTALLED_MESSAGE : AXE_LOAD_FAILED_MESSAGE, { cause: error })
      },
    )
    return axe
  }

  /**
   * Name the violating elements from the normalised snapshot (#82): role,
   * accessible name and path. An element the snapshot does not hold (the
   * document itself, a wrapper with no role, anything inside a frame) gets
   * no path: its selector names it instead.
   */
  const elementNamer = async (browserPage: BrowserPage, raw: RawAudit): Promise<(selector: string | undefined) => Omit<A11yAuditNode, 'target'>> => {
    const selectors = [...new Set(raw.violations.flatMap((violation) => violation.nodes.flatMap((node) => (node.selector === undefined ? [] : [node.selector]))))].slice(
      0,
      MAX_NAMED_ELEMENTS,
    )
    const named = new Map<string, SnapshotNode>()
    if (selectors.length > 0) {
      try {
        const original = normaliseAriaSnapshot(await browserPage.ariaSnapshot())
        // Which snapshot node an element is cannot be read off a selector, so
        // the page is asked: each element is given a marker for a name, the
        // snapshot is taken again, and the node now wearing the marker sits
        // where the element's own node sits in the snapshot taken before.
        // The marker is removed at once, and a marking that changed the
        // shape of the tree names nothing.
        const locate = async (subset: readonly string[]): Promise<boolean> => {
          const marks = subset.map((selector, index) => ({ selector, marker: `${MARKER_PREFIX}${index}` }))
          const previous = await browserPage.evaluate(markInPage, marks)
          let marked: SnapshotNode
          try {
            marked = normaliseAriaSnapshot(await browserPage.ariaSnapshot())
          } finally {
            await browserPage.evaluate(unmarkInPage, marks.map((mark, index) => ({ selector: mark.selector, previous: previous[index] ?? null })))
          }
          const found = new Map<string, SnapshotNode>()
          const pair = (before: SnapshotNode, after: SnapshotNode): boolean => {
            if (before.role !== after.role || before.children.length !== after.children.length) return false
            const mark = marks.find((entry) => entry.marker === after.name)
            if (mark !== undefined) found.set(mark.selector, before)
            return before.children.every((child, index) => pair(child, after.children[index] as SnapshotNode))
          }
          if (!pair(original, marked)) return false
          for (const [selector, node] of found) named.set(selector, node)
          return true
        }
        // All at once when the tree keeps its shape; one by one when a marker
        // gave some element a role it did not have.
        if (!(await locate(selectors))) for (const selector of selectors) await locate([selector])
      } catch {
        // An element that cannot be named is still reported, by its selector.
      }
    }
    return (selector) => {
      const node = selector === undefined ? undefined : named.get(selector)
      return node === undefined ? {} : { role: node.role, ...(node.name === undefined ? {} : { name: node.name }), path: node.path }
    }
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

  return { capabilities: BROWSER_FLOW_DRIVER, page, trace, dispose, outbound: () => [...outbound], console: () => platform.lines(), platformLog: () => platform.entries() }
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
