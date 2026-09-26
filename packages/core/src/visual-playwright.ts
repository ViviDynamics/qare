import type { VisualCheckOpts } from './visual.js'

const NOT_INSTALLED_MESSAGE =
  'playwright-core is not installed; visual checks are unverified without a screenshot backend'
const LOAD_FAILED_MESSAGE =
  'playwright-core failed to load; visual checks are unverified without a working backend'

type PlaywrightModule = typeof import('playwright-core')

export class PlaywrightScreenshotBackendError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlaywrightScreenshotBackendError'
  }
}

type ScreenshotFn = NonNullable<VisualCheckOpts['screenshot']>

export async function makePlaywrightScreenshot(
  opts: {
    browserExecutablePath?: string
    loadPlaywright?: () => Promise<PlaywrightModule>
    masks?: string[]
  } = {},
): Promise<ScreenshotFn> {
  const loadPlaywright =
    opts.loadPlaywright ?? ((): Promise<PlaywrightModule> => import('playwright-core'))
  let playwright: PlaywrightModule
  try {
    playwright = await loadPlaywright()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ERR_MODULE_NOT_FOUND')
      throw new PlaywrightScreenshotBackendError(NOT_INSTALLED_MESSAGE, { cause: error })
    throw new PlaywrightScreenshotBackendError(LOAD_FAILED_MESSAGE, { cause: error })
  }
  const chromium = playwright.chromium

  type Browser = Awaited<ReturnType<typeof chromium.launch>>

  let launching: Promise<Browser> | null = null

  const launch = (): Promise<Browser> => {
    launching ??= chromium
      .launch({ headless: true, executablePath: opts.browserExecutablePath })
      .catch((error: unknown) => {
        // a failed launch must not poison the cached promise: the next capture retries
        launching = null
        throw error
      })
    return launching
  }

  const dispose = async (): Promise<void> => {
    if (launching !== null) {
      const pending = launching
      launching = null
      const instance = await pending
      await instance.close()
    }
  }

  const screenshot: ScreenshotFn = async (url, width, theme, revision) => {
    void revision
    const browser = await launch()
    const context = await browser.newContext({
      viewport: { width, height: 1080 },
      reducedMotion: 'reduce',
      colorScheme: theme === 'dark' ? 'dark' : 'light',
    })
    try {
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'networkidle' })
      // The masks are the profile's own, revision-blind (#119): base and head
      // screenshots black out the same regions, so masking never shows as a
      // visual difference. They black out at capture, in the browser.
      return await page.screenshot(
        opts.masks === undefined || opts.masks.length === 0
          ? { type: 'png' }
          : {
              type: 'png',
              mask: opts.masks.map((selector) => page.locator(selector)),
              maskColor: '#000000',
            },
      )
    } finally {
      await context.close()
    }
  }

  return Object.assign(screenshot, { dispose })
}

export async function disposeBrowser(screenshot: unknown): Promise<void> {
  const dispose = (screenshot as { dispose?: () => Promise<void> } | null | undefined)?.dispose
  if (typeof dispose === 'function') {
    await dispose()
  }
}
