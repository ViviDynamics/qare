import { expect, test, vi } from 'vitest'
import { attemptOf, BROWSER_FLOW_DRIVER, makePlaywrightFlowSession, markInPage, runAxeInPage, unmarkInPage } from '../src/flow-playwright.js'

const NOT_INSTALLED_MESSAGE =
  'playwright-core is not installed; flow checks are unverified without a browser backend'

const APP_URL = ['http:', '//localhost:3000/up'].join('')
const TRACE_PATH = '/tmp/qare-flow-trace.zip'

function fakeChromium(events: string[], opts: { visible?: boolean; subresources?: string[]; sockets?: string[] } = {}) {
  const onSocket: Array<(socket: { url: () => string }) => void> = []
  const onRequest: Array<(request: { url: () => string }) => void> = []
  const request = (url: string) => {
    for (const handler of onRequest) handler({ url: () => url })
  }
  const locator = (name: string) => {
    const self = {
      click: async () => events.push(`click ${name}`),
      fill: async (value: string) => events.push(`fill ${name}=${value}`),
      selectOption: async (value: { label: string }) => events.push(`choose ${name}=${value.label}`),
      waitFor: async (opts: { state: string }) => events.push(`waitFor ${name} until ${opts.state}`),
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
          const onPage: Array<(page: unknown) => void> = []
          return {
            on: (event: string, handler: (arg: never) => void) => {
              if (event === 'request') onRequest.push(handler as (request: { url: () => string }) => void)
              if (event === 'page') onPage.push(handler as (page: unknown) => void)
            },
            tracing: {
              start: async (opts: { screenshots: boolean; snapshots: boolean }) => {
                events.push(`start ${JSON.stringify(opts)}`)
              },
              stop: async (opts: { path: string }) => {
                events.push(`stop ${opts.path}`)
              },
            },
            // Like Playwright, the context raises `page` for every page it opens.
            newPage: async () => {
              const page = {
              // A real page says where it is: the platform log names it when it opens (#78).
              url: () => 'about:blank',
              goto: async (url: string) => {
                events.push(`open ${url}`)
                request(url)
                for (const sub of opts.subresources ?? []) request(sub)
                for (const socket of opts.sockets ?? []) for (const handler of onSocket) handler({ url: () => socket })
              },
              on: (event: string, handler: (socket: { url: () => string }) => void) => {
                if (event === 'websocket') onSocket.push(handler)
              },
              getByRole: (role: string, options: { name: string }) =>
                locator(`${role}=${options.name}`),
              getByTestId: (testId: string) => locator(`testId=${testId}`),
              getByText: (text: string) => locator(`text=${text}`),
              screenshot: async (opts: { path: string }) => events.push(`screenshot ${opts.path}`),
              }
              for (const handler of onPage) handler(page)
              return page
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

test('session screenshots black out the profile masks at capture (#119)', async () => {
  const screenshotOpts: unknown[] = []
  const locators: string[] = []
  const chromium = {
    launch: () =>
      Promise.resolve({
        newContext: async () => ({
          on: () => undefined,
          newPage: async () => ({
            goto: async () => undefined,
            locator: (selector: string) => {
              locators.push(selector)
              return { selector }
            },
            screenshot: async (capture: unknown) => {
              screenshotOpts.push(capture)
              return undefined
            },
          }),
        }),
        close: async () => undefined,
      }),
  }
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () => ({ chromium }) as never,
    masks: ['css=.fixture-banner', 'text="jane@pilot.example"'],
  })

  await session.page.screenshot('/tmp/qare-flow-final.png')
  await session.dispose()

  expect(locators).toEqual(['css=.fixture-banner', 'text="jane@pilot.example"'])
  expect(screenshotOpts).toEqual([
    {
      path: '/tmp/qare-flow-final.png',
      mask: [{ selector: 'css=.fixture-banner' }, { selector: 'text="jane@pilot.example"' }],
      maskColor: '#000000',
    },
  ])
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
  await session.page.choose({ role: 'combobox', name: 'Country' }, 'Ireland')
  await session.page.waitFor({ testId: 'address-form' })
  await session.page.click({ testId: 'sign-in' })
  await session.page.assertText('Welcome to QARE')
  await session.page.assertElement({ testId: 'welcome-banner' })
  await session.page.screenshot('/tmp/qare-flow-final.png')
  await session.trace.stop(TRACE_PATH)
  await session.dispose()

  expect(session.capabilities).toBe(BROWSER_FLOW_DRIVER)
  expect(events).toEqual([
    'launch',
    'context',
    'start {"screenshots":true,"snapshots":true}',
    `open ${APP_URL}`,
    'fill textbox=Email=me@example.com',
    'choose combobox=Country=Ireland',
    'waitFor testId=address-form until visible',
    'click testId=sign-in',
    'visible text=Welcome to QARE',
    'visible testId=welcome-banner',
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

test('assertElement throws when the element is not visible (#70)', async () => {
  const events: string[] = []
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () => ({ chromium: fakeChromium(events, { visible: false }) }) as never,
  })

  await expect(session.page.assertElement({ testId: 'welcome-banner' })).rejects.toThrow(
    'assert failed: the element is not visible',
  )
})

test('the session records every connection its page attempted, and nothing that stays in the browser (#122)', async () => {
  const events: string[] = []
  const cdn = ['https:', '//cdn.example.org/app.js'].join('')
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () =>
      ({
        chromium: fakeChromium(events, {
          subresources: [cdn, 'data:image/png;base64,AAAA', 'blob:whatever'],
          sockets: [['wss:', '//live.example.org/socket'].join('')],
        }),
      }) as never,
  })

  expect(session.outbound()).toEqual([])
  await session.page.open(APP_URL)
  await session.dispose()

  expect(session.outbound()).toEqual([
    { host: 'localhost', port: 3000, protocol: 'http' },
    { host: 'cdn.example.org', port: 443, protocol: 'https' },
    { host: 'live.example.org', port: 443, protocol: 'wss' },
  ])
})

test('a connection attempt carries the default port when the URL names none', () => {
  expect(attemptOf(['http:', '//example.org/'].join(''))).toEqual({ host: 'example.org', port: 80, protocol: 'http' })
  expect(attemptOf(['wss:', '//example.org:8443/socket'].join(''))).toEqual({ host: 'example.org', port: 8443, protocol: 'wss' })
  expect(attemptOf('not a url')).toBeUndefined()
  expect(attemptOf('about:blank')).toBeUndefined()
})

test('the browser driver maps the page ARIA snapshot onto the normalised schema (#82)', async () => {
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () =>
      ({
        chromium: {
          launch: () =>
            Promise.resolve({
              newContext: async () => ({
                on: () => undefined,
                newPage: async () => ({
                  goto: async () => undefined,
                  ariaSnapshot: async () => '- main:\n  - heading "QARE" [level=1]',
                }),
              }),
              close: async () => undefined,
            }),
        },
      }) as never,
  })

  const snapshot = await session.page.snapshot!()
  await session.dispose()

  expect(snapshot.path).toBe('document')
  expect(snapshot.children[0]?.role).toBe('main')
  const heading = snapshot.children[0]?.children[0]
  expect(heading?.name).toBe('QARE')
  expect(heading?.states).toEqual({ level: 1 })
  expect(heading?.path).toBe('document/main/heading "QARE"')
})

test('a reference that carries a snapshot path resolves by walking it (#83)', async () => {
  const events: string[] = []
  const locator = (label: string, walk: string[]) => {
    const self = {
      getByRole: (role: string, options: { name?: string; exact?: boolean } = {}) => {
        const step = `${role}${options.name === undefined ? '' : ` ${options.name}`}${options.exact === true ? ' exact' : ''}`
        return locator(step, [...walk, step])
      },
      nth: (n: number) => {
        events.push(`nth ${n + 1}`)
        return self
      },
      click: async () => events.push(`click ${walk.at(-1) ?? ''}`),
      fill: async (value: string) => events.push(`fill ${walk.at(-1) ?? ''}=${value}`),
      selectOption: async (value: { label: string }) => events.push(`choose ${walk.at(-1) ?? ''}=${value.label}`),
      waitFor: async () => events.push(`waitFor ${walk.at(-1) ?? ''}`),
      isVisible: async () => true,
      first: () => self,
    }
    events.push(walk.join(' / '))
    return self
  }
  const chromium = {
    launch: () =>
      Promise.resolve({
        newContext: async () => ({
          on: () => undefined,
          newPage: async () => ({
            goto: async () => undefined,
            getByRole: (role: string, options: { name?: string; exact?: boolean } = {}) => {
              const step = `${role}${options.name === undefined ? '' : ` ${options.name}`}${options.exact === true ? ' exact' : ''}`
              return locator(step, [step])
            },
            getByTestId: (testId: string) => locator(`testId=${testId}`, [`testId=${testId}`]),
            screenshot: async () => undefined,
          }),
        }),
        close: async () => undefined,
      }),
  }
  const session = await makePlaywrightFlowSession({ loadPlaywright: async () => ({ chromium }) as never })

  // The path is walked role by role, name by name, from the document down:
  // the element the plan named is reached through the landmarks it sat in.
  await session.page.type({ role: 'textbox', name: 'Search', at: 'document/main/textbox "Search"' }, 'Ada Lovelace')
  await session.page.click({ role: 'button', name: 'Send', at: 'document/main/list/link "Ada"[2]' })
  await session.dispose()

  expect(events).toEqual([
    'main',
    'main / textbox Search exact',
    'fill textbox Search exact=Ada Lovelace',
    'main',
    'main / list',
    'main / list / link Ada exact',
    'nth 2',
    'click link Ada exact',
  ])
})

const HELP_URL = ['https:', '//dequeuniversity.com/rules/axe/4.13/button-name'].join('')

/**
 * A page the audit seam can drive: what the rule engine answers, and the
 * page's snapshot. `snapshot` renders the tree with the accessible names the
 * marked elements wear, by selector: an element the tree does not hold is
 * simply never rendered.
 */
function auditableChromium(events: string[], opts: { raw: unknown; snapshot: (names: Record<string, string>) => string }) {
  let viewport = { width: 1280, height: 720 }
  let names: Record<string, string> = {}
  const page = {
    goto: async () => undefined,
    url: () => APP_URL,
    viewportSize: () => viewport,
    setViewportSize: async (size: { width: number; height: number }) => {
      viewport = size
      events.push(`viewport ${size.width}x${size.height}`)
    },
    emulateMedia: async (media: { colorScheme: string | null }) => events.push(`scheme ${String(media.colorScheme)}`),
    evaluate: async (script: unknown, arg?: unknown) => {
      if (typeof script === 'string') {
        events.push(`inject ${script}`)
        return undefined
      }
      if (script === markInPage) {
        const marks = arg as Array<{ selector: string; marker: string }>
        names = Object.fromEntries(marks.map((mark) => [mark.selector, mark.marker]))
        events.push(`mark ${marks.map((mark) => mark.selector).join(', ')}`)
        return marks.map(() => null)
      }
      if (script === unmarkInPage) {
        names = {}
        events.push(`unmark ${(arg as Array<{ selector: string; previous: string | null }>).map((mark) => `${mark.selector}=${String(mark.previous)}`).join(', ')}`)
        return undefined
      }
      events.push(`run ${JSON.stringify(arg)}`)
      return opts.raw
    },
    ariaSnapshot: async () => opts.snapshot(names),
    locator: (selector: string) => ({ selector }),
    getByRole: (role: string, options: { name: string }) => ({ role, name: options.name }),
    screenshot: async (capture: { path: string; fullPage?: boolean; mask?: unknown[] }) =>
      events.push(`screenshot ${capture.path}${capture.fullPage === true ? ' full page' : ''}${capture.mask === undefined ? '' : ` masked ${capture.mask.length}`}`),
  }
  return {
    launch: () => Promise.resolve({ newContext: async () => ({ on: () => undefined, newPage: async () => page }), close: async () => undefined }),
  }
}

const RAW_AUDIT = {
  version: '4.13.0',
  incomplete: 2,
  violations: [
    { id: 'button-name', impact: 'critical', help: 'Buttons must have discernible text', helpUrl: HELP_URL, nodes: [{ target: 'button:nth-child(2)', selector: 'button:nth-child(2)' }] },
    { id: 'html-has-lang', impact: 'serious', help: 'The html element must have a lang attribute', nodes: [{ target: 'html', selector: 'html' }] },
  ],
}

// Two buttons, the second with no name of its own. The document element is no
// node of the snapshot, so a marker on it changes nothing.
const auditedSnapshot = (names: Record<string, string>): string => {
  const marker = names['button:nth-child(2)']
  return `- main:\n  - button "Save"\n  - button${marker === undefined ? '' : ` ${JSON.stringify(marker)}`}`
}

test('the browser driver audits the page with axe-core and names each element from the snapshot (#149)', async () => {
  const events: string[] = []
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () => ({ chromium: auditableChromium(events, { raw: RAW_AUDIT, snapshot: auditedSnapshot }) }) as never,
    loadAxe: async () => ({ source: 'AXE SOURCE' }),
    masks: ['css=.fixture-banner'],
  })

  const audit = await session.page.audit!({ tags: ['wcag2a', 'wcag2aa'], width: 390, theme: 'dark', screenshot: '/tmp/qare-a11y.png' })
  await session.dispose()

  expect(audit).toEqual({
    url: APP_URL,
    width: 390,
    theme: 'dark',
    engine: { name: 'axe-core', version: '4.13.0' },
    incomplete: 2,
    screenshot: true,
    violations: [
      {
        rule: 'button-name',
        impact: 'critical',
        help: 'Buttons must have discernible text',
        helpUrl: HELP_URL,
        nodes: [{ target: 'button:nth-child(2)', role: 'button', path: 'document/main/button' }],
      },
      { rule: 'html-has-lang', impact: 'serious', help: 'The html element must have a lang attribute', nodes: [{ target: 'html' }] },
    ],
  })
  // The page is audited at the width and scheme asked for, and put back as the flow had it.
  expect(events).toEqual([
    'viewport 390x720',
    'scheme dark',
    'inject AXE SOURCE',
    'run {"tags":["wcag2a","wcag2aa"]}',
    // Each element wears a marker for one snapshot, and gets back what it carried.
    'mark button:nth-child(2), html',
    'unmark button:nth-child(2)=null, html=null',
    'screenshot /tmp/qare-a11y.png full page masked 1',
    'scheme null',
    'viewport 1280x720',
  ])
})

test('an element the flow concealed is blacked out in the audit screenshot too (#78)', async () => {
  const events: string[] = []
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () => ({ chromium: auditableChromium(events, { raw: RAW_AUDIT, snapshot: auditedSnapshot }) }) as never,
    loadAxe: async () => ({ source: 'AXE SOURCE' }),
    masks: ['css=.fixture-banner'],
  })

  await session.page.audit!({ tags: ['wcag2a'], theme: 'light', screenshot: '/tmp/qare-a11y.png', conceal: [{ role: 'textbox', name: 'Passphrase' }] })
  await session.dispose()

  // The profile's mask and the concealed field: two regions.
  expect(events).toContain('screenshot /tmp/qare-a11y.png full page masked 2')
})

test('a marker that changes the shape of the tree names nothing, and the elements are then marked one by one (#149)', async () => {
  const events: string[] = []
  const raw = {
    version: '4.13.0',
    incomplete: 0,
    violations: [{ id: 'color-contrast', impact: 'serious', help: 'Contrast', nodes: [{ target: 'section', selector: 'section' }, { target: 'a', selector: 'a' }] }],
  }
  // A section with a name becomes a region: the marker gives the tree a node it did not have.
  const snapshot = (names: Record<string, string>): string => {
    const link = `- link ${JSON.stringify(names.a ?? 'Home')}`
    return names.section === undefined ? `- main:\n  ${link}` : `- main:\n  - region ${JSON.stringify(names.section)}:\n    ${link}`
  }
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () => ({ chromium: auditableChromium(events, { raw, snapshot }) }) as never,
    loadAxe: async () => ({ source: 'AXE SOURCE' }),
  })

  const audit = await session.page.audit!({ tags: ['wcag2a'], theme: 'light' })
  await session.dispose()

  expect(audit.violations[0]?.nodes).toEqual([{ target: 'section' }, { target: 'a', role: 'link', name: 'Home', path: 'document/main/link "Home"' }])
  expect(events.filter((event) => event.startsWith('mark'))).toEqual(['mark section, a', 'mark section', 'mark a'])
})

test('a clean page takes no screenshot, and the viewport is left alone when no width is asked (#149)', async () => {
  const events: string[] = []
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () =>
      ({ chromium: auditableChromium(events, { raw: { version: '4.13.0', incomplete: 0, violations: [] }, snapshot: () => '- main' }) }) as never,
    loadAxe: async () => ({ source: 'AXE SOURCE' }),
  })

  const audit = await session.page.audit!({ tags: ['wcag2a'], theme: 'light', screenshot: '/tmp/qare-a11y.png' })
  await session.dispose()

  expect(audit).toMatchObject({ width: 1280, theme: 'light', violations: [] })
  expect(audit.screenshot).toBeUndefined()
  expect(events).toEqual(['scheme light', 'inject AXE SOURCE', 'run {"tags":["wcag2a"]}', 'scheme null'])
})

test('an audit without axe-core names what is missing (#149)', async () => {
  const session = await makePlaywrightFlowSession({
    loadPlaywright: async () => ({ chromium: auditableChromium([], { raw: {}, snapshot: () => '' }) }) as never,
    loadAxe: async () => {
      const error = new Error('Cannot find package') as NodeJS.ErrnoException
      error.code = 'ERR_MODULE_NOT_FOUND'
      throw error
    },
  })
  await expect(session.page.audit!({ tags: ['wcag2a'], theme: 'light' })).rejects.toThrow('axe-core is not installed; accessibility checks are unverified without the rule engine')
  await session.dispose()
})

test('the function run in the page asks the engine for the rule set and flattens what it found (#149)', async () => {
  const asked: unknown[] = []
  // The function runs in the page, where these are the page's own globals.
  vi.stubGlobal('axe', {
    version: '4.13.0',
    run: async (_context: unknown, options: unknown) => {
      asked.push(options)
      return {
        violations: [
          {
            id: 'button-name',
            impact: 'critical',
            help: 'Buttons must have discernible text',
            helpUrl: HELP_URL,
            // One element in the page, one inside a frame, one inside a shadow root.
            nodes: [{ target: ['button'] }, { target: ['iframe#pay', 'button'] }, { target: [['x-card', 'button']] }],
          },
        ],
        incomplete: [{ id: 'color-contrast' }],
      }
    },
  })
  vi.stubGlobal('document', {})
  vi.stubGlobal('requestAnimationFrame', (done: () => void) => done())
  let raw: unknown
  try {
    raw = await runAxeInPage({ tags: ['wcag2a'] })
  } finally {
    vi.unstubAllGlobals()
  }
  expect(asked).toEqual([{ runOnly: { type: 'tag', values: ['wcag2a'] }, resultTypes: ['violations', 'incomplete'] }])
  expect(raw).toEqual({
    version: '4.13.0',
    incomplete: 1,
    violations: [
      {
        id: 'button-name',
        impact: 'critical',
        help: 'Buttons must have discernible text',
        helpUrl: HELP_URL,
        // Only an element of the page itself has a selector the snapshot can be asked about.
        nodes: [{ target: 'button', selector: 'button' }, { target: 'iframe#pay button' }, { target: 'x-card button' }],
      },
    ],
  })
})

/** A browser whose one page raises the events a real page raises, and writes down what each capture was asked. */
function observedChromium(captures: unknown[]) {
  const handlers = new Map<string, Array<(arg: unknown) => void>>()
  const onPage: Array<(page: unknown) => void> = []
  const page = {
    url: () => 'about:blank',
    on: (event: string, handler: (arg: unknown) => void) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    locator: (selector: string) => ({ selector }),
    getByRole: (role: string, options: { name: string }) => ({ role, name: options.name }),
    getByTestId: (testId: string) => ({ testId }),
    screenshot: async (capture: unknown) => {
      captures.push(capture)
      return Buffer.from('a frame')
    },
  }
  const emit = (event: string, arg?: unknown): void => {
    for (const handler of handlers.get(event) ?? []) handler(arg)
  }
  const chromium = {
    launch: () =>
      Promise.resolve({
        newContext: async () => ({
          on: (event: string, handler: (page: unknown) => void) => {
            if (event === 'page') onPage.push(handler)
          },
          newPage: async () => {
            for (const handler of onPage) handler(page)
            return page
          },
        }),
        close: async () => undefined,
      }),
  }
  const popup = (url: string): { emit: (event: string, arg?: unknown) => void } => {
    const own = new Map<string, Array<(arg: unknown) => void>>()
    for (const handler of onPage) handler({ url: () => url, on: (event: string, listener: (arg: unknown) => void) => own.set(event, [...(own.get(event) ?? []), listener]) })
    return { emit: (event, arg) => (own.get(event) ?? []).forEach((listener) => listener(arg)) }
  }
  return { chromium, emit, popup }
}

test('the browser driver declares the recording and the console beside its screenshots and trace (#78)', () => {
  expect(BROWSER_FLOW_DRIVER.evidence).toEqual(['screenshot', 'trace', 'console', 'recording'])
})

test('a frame is a screenshot in memory: masked as one, with every concealed element blacked out, and given five seconds (#78)', async () => {
  const captures: unknown[] = []
  const { chromium } = observedChromium(captures)
  const session = await makePlaywrightFlowSession({ loadPlaywright: async () => ({ chromium }) as never, masks: ['css=.fixture-banner'] })

  const frame = await session.page.frame?.({ conceal: [{ role: 'textbox', name: 'Passphrase' }, { testId: 'pin' }] })
  await session.page.frame?.()
  await session.page.screenshot('/tmp/qare-failure.png', { conceal: [{ role: 'textbox', name: 'Passphrase' }] })
  await session.dispose()

  expect(Buffer.from(frame as Uint8Array).toString()).toBe('a frame')
  // The driver says it conceals, which is what lets a flow go on recording past a typed secret.
  expect(session.page.conceals).toBe(true)
  expect(captures).toEqual([
    { type: 'png', scale: 'css', timeout: 5000, mask: [{ selector: 'css=.fixture-banner' }, { role: 'textbox', name: 'Passphrase' }, { testId: 'pin' }], maskColor: '#000000' },
    { type: 'png', scale: 'css', timeout: 5000, mask: [{ selector: 'css=.fixture-banner' }], maskColor: '#000000' },
    { path: '/tmp/qare-failure.png', mask: [{ selector: 'css=.fixture-banner' }, { role: 'textbox', name: 'Passphrase' }], maskColor: '#000000' },
  ])
})

test('a frame of a page with nothing to hide asks for no mask (#78)', async () => {
  const captures: unknown[] = []
  const { chromium } = observedChromium(captures)
  const session = await makePlaywrightFlowSession({ loadPlaywright: async () => ({ chromium }) as never })

  await session.page.frame?.()
  await session.dispose()

  expect(captures).toEqual([{ type: 'png', scale: 'css', timeout: 5000 }])
})

test('the browser has a platform log too: console messages, page errors, a crashed page, and every page that opened or closed (#78)', async () => {
  const { chromium, emit, popup } = observedChromium([])
  const session = await makePlaywrightFlowSession({ loadPlaywright: async () => ({ chromium }) as never })

  await session.page.frame?.()
  emit('console', { type: () => 'error', text: () => 'the save failed' })
  emit('pageerror', new Error('undefined is not a function'))
  const second = popup('about:blank#details')
  second.emit('console', { type: () => 'log', text: () => 'details ready' })
  second.emit('close')
  emit('crash')
  await session.dispose()

  expect(session.console()).toEqual([
    '[page 1 opened] about:blank',
    '[page 1 console.error] the save failed',
    '[page 1 error] undefined is not a function',
    '[page 2 opened] about:blank#details',
    '[page 2 console.log] details ready',
    '[page 2 closed]',
    '[page 1 crashed]',
  ])
  const entries = session.platformLog()
  expect(entries.map((entry) => entry.line)).toEqual(session.console())
  for (const entry of entries) expect(entry.at).toBeGreaterThan(0)
})
