import type { VisualCheckOpts } from './visual.js'

const NOT_INSTALLED_MESSAGE =
  'playwright-core is not installed; visual checks are unverified without a screenshot backend'

export class PlaywrightScreenshotBackendError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlaywrightScreenshotBackendError'
  }
}

type ScreenshotFn = NonNullable<VisualCheckOpts['screenshot']>

export async function makePlaywrightScreenshot(
  opts: { browserExecutablePath?: string } = {},
): Promise<ScreenshotFn> {
  let playwright: typeof import('playwright-core')
  try {
    playwright = await import('playwright-core')
  } catch (error) {
    throw new PlaywrightScreenshotBackendError(NOT_INSTALLED_MESSAGE, { cause: error })
  }
  const chromium = playwright.chromium

  type Browser = Awaited<ReturnType<typeof chromium.launch>>

  let launching: Promise<Browser> | null = null

  const launch = (): Promise<Browser> => {
    launching ??= chromium.launch({ headless: true, executablePath: opts.browserExecutablePath })
    return launching
  }

  const dispose = async (): Promise<void> => {
    if (launching !== null) {
      const instance = await launching
      launching = null
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
      return await page.screenshot({ type: 'png' })
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
