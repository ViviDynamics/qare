import { expect, expectTypeOf, test } from 'vitest'
import type { VisualCheckOpts } from '../src/index.js'
import { makePlaywrightScreenshot } from '../src/visual-playwright.js'

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
