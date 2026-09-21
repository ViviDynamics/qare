import { expect, test } from 'vitest'
import { makePlaywrightFlowSession } from '../src/flow-playwright.js'

const NOT_INSTALLED_MESSAGE =
  'playwright-core is not installed; flow checks are unverified without a browser backend'

const APP_URL = ['http:', '//localhost:3000/up'].join('')
const TRACE_PATH = '/tmp/qare-flow-trace.zip'

function fakeChromium(events: string[]) {
  return {
    launch: () => {
      events.push('launch')
      return Promise.resolve({
        newContext: async () => {
          events.push('context')
          return {
            tracing: {
              start: async (opts: { screenshots: boolean; snapshots: boolean }) => {
                events.push(`start ${JSON.stringify(opts)}`)
              },
              stop: async (opts: { path: string }) => {
                events.push(`stop ${opts.path}`)
              },
            },
            newPage: async () => {
              events.push('page')
              return {
                goto: async (url: string) => events.push(`navigate ${url}`),
                click: async (selector: string) => events.push(`click ${selector}`),
                fill: async (selector: string, value: string) =>
                  events.push(`fill ${selector}=${value}`),
                locator: (selector: string) => ({
                  textContent: async () => {
                    events.push(`textContent ${selector}`)
                    return 'Welcome to QARE'
                  },
                }),
              }
            },
          }
        },
        close: async () => events.push('close'),
      })
    },
  }
}

test('an injected loader that fails rejects deterministically with the named error', async () => {
  const session = makePlaywrightFlowSession({
    loadPlaywright: async () => {
      const error = new Error('engine mismatch') as NodeJS.ErrnoException
      error.code = 'ERR_MODULE_NOT_FOUND'
      throw error
    },
  })
  await expect(session).rejects.toThrow(NOT_INSTALLED_MESSAGE)
})

test('an injected loader crashing with a non-NotFound code names the load failure', async () => {
  const session = makePlaywrightFlowSession({
    loadPlaywright: async () => {
      throw new Error('engine mismatch')
    },
  })
  await expect(session).rejects.toThrow('playwright-core failed to load')
})

test('a session drives one browser and hands the stop path to playwright tracing', async () => {
  const events: string[] = []
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () => ({ chromium: fakeChromium(events) }) as never,
  })

  await session.trace.start()
  await session.page.navigate(APP_URL)
  await session.page.fill('#email', 'me@example.com')
  await session.page.click('button[type=submit]')
  await session.page.assertText('h1', 'Welcome to QARE')
  await session.trace.stop(TRACE_PATH)
  await session.dispose()

  expect(events).toEqual([
    'launch',
    'context',
    'page',
    'start {"screenshots":true,"snapshots":true}',
    `navigate ${APP_URL}`,
    'fill #email=me@example.com',
    'click button[type=submit]',
    'textContent h1',
    `stop ${TRACE_PATH}`,
    'close',
  ])
})

test('assertText throws naming the selector and text when the page shows something else', async () => {
  const events: string[] = []
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () => ({ chromium: fakeChromium(events) }) as never,
  })

  await expect(session.page.assertText('h1', 'Goodbye')).rejects.toThrow(
    'assert failed: h1 does not contain "Goodbye"',
  )
})
