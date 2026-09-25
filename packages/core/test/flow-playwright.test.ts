import { expect, test } from 'vitest'
import { makePlaywrightFlowSession } from '../src/flow-playwright.js'

const NOT_INSTALLED_MESSAGE =
  'playwright-core is not installed; flow checks are unverified without a browser backend'

const APP_URL = ['http:', '//localhost:3000/up'].join('')
const TRACE_PATH = '/tmp/qare-flow-trace.zip'

function fakeChromium(events: string[], opts: { visible?: boolean } = {}) {
  const locator = (name: string) => {
    const self = {
      click: async () => events.push(`click ${name}`),
      fill: async (value: string) => events.push(`fill ${name}=${value}`),
      isVisible: async () => {
        events.push(`visible ${name}`)
        return opts.visible ?? true
      },
      first: () => self,
    }
    return self
  }
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
            newPage: async () => ({
              goto: async (url: string) => events.push(`open ${url}`),
              getByRole: (role: string, options: { name: string }) =>
                locator(`${role}=${options.name}`),
              getByTestId: (testId: string) => locator(`testId=${testId}`),
              getByText: (text: string) => locator(`text=${text}`),
              screenshot: async (opts: { path: string }) => events.push(`screenshot ${opts.path}`),
            }),
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

test('a session resolves semantic elements and drives one browser through the seams', async () => {
  const events: string[] = []
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () => ({ chromium: fakeChromium(events) }) as never,
  })

  await session.trace.start()
  await session.page.open(APP_URL)
  await session.page.type({ role: 'textbox', name: 'Email' }, 'me@example.com')
  await session.page.click({ testId: 'sign-in' })
  await session.page.assertText('Welcome to QARE')
  await session.page.screenshot('/tmp/qare-flow-final.png')
  await session.trace.stop(TRACE_PATH)
  await session.dispose()

  expect(events).toEqual([
    'launch',
    'context',
    'start {"screenshots":true,"snapshots":true}',
    `open ${APP_URL}`,
    'fill textbox=Email=me@example.com',
    'click testId=sign-in',
    'visible text=Welcome to QARE',
    'screenshot /tmp/qare-flow-final.png',
    `stop ${TRACE_PATH}`,
    'close',
  ])
})

test('assertText throws naming the text when the page shows something else', async () => {
  const events: string[] = []
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () => ({ chromium: fakeChromium(events, { visible: false }) }) as never,
  })

  await expect(session.page.assertText('Goodbye')).rejects.toThrow(
    'assert failed: the text "Goodbye" is not visible',
  )
})
