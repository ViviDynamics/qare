import { expect, expectTypeOf, test } from 'vitest'
import type { VisualCheckOpts } from '../src/index.js'
import { disposeBrowser, makePlaywrightScreenshot } from '../src/visual-playwright.js'

const NOT_INSTALLED_MESSAGE =
  'playwright-core is not installed; visual checks are unverified without a screenshot backend'

test('makePlaywrightScreenshot return is assignable to the visual screenshot seam', () => {
  expectTypeOf<ReturnType<typeof makePlaywrightScreenshot>>().toEqualTypeOf<
    Promise<NonNullable<VisualCheckOpts['screenshot']>>
  >()
})

test('factory rejects with a named error when playwright-core is absent', async () => {
  let installed = true
  try {
    await import('playwright-core')
  } catch {
    installed = false
  }
  if (installed) return
  await expect(makePlaywrightScreenshot()).rejects.toThrow(NOT_INSTALLED_MESSAGE)
})

test('an injected loader that fails rejects deterministically with the named error', async () => {
  const backend = makePlaywrightScreenshot({
    loadPlaywright: async () => {
      const error = new Error('engine mismatch') as NodeJS.ErrnoException
      error.code = 'ERR_MODULE_NOT_FOUND'
      throw error
    },
  })
  await expect(backend).rejects.toThrow(NOT_INSTALLED_MESSAGE)
})

test('an injected loader that crashes with a non-NotFound code names the load failure', async () => {
  const backend = makePlaywrightScreenshot({
    loadPlaywright: async () => {
      throw new Error('engine mismatch')
    },
  })
  await expect(backend).rejects.toThrow('playwright-core failed to load')
})

test('a rejected first launch does not poison later captures', async () => {
  const OFFLINE_URL = ['http:', '//localhost:3000/up'].join('')
  const PNG_CAPTURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x02])
  let launches = 0
  const chromium = {
    launch: () => {
      launches += 1
      if (launches === 1) return Promise.reject(new Error('transient browser crash'))
      return Promise.resolve({
        newContext: async () => ({
          newPage: async () => ({
            goto: async () => undefined,
            screenshot: async () => PNG_CAPTURE,
          }),
          close: async () => undefined,
        }),
        close: async () => undefined,
      })
    },
  }
  const backend = await makePlaywrightScreenshot({
    loadPlaywright: async () => ({ chromium }) as never,
  })
  await expect(backend(OFFLINE_URL, 1440, 'light', 'head')).rejects.toThrow('transient browser crash')
  await expect(backend(OFFLINE_URL, 1440, 'light', 'head')).resolves.toBeInstanceOf(Buffer)
  await disposeBrowser(backend)
})
