import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runVisualCheck, type VisualCheckOpts } from '../src/index.js'

const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x01])
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x02])
const PNG_C = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x03])

const BASE_URL = ['http:', '//localhost:3000/up'].join('')

/**
 * The seam receives only (url, width, theme) — no revision — so each pair's
 * queue supplies buffers in call order; runVisualCheck visits base before head.
 */
function fakeScreenshot(images: Map<string, Buffer[]>): {
  screenshot: NonNullable<VisualCheckOpts['screenshot']>
  calls: string[]
} {
  const queues = new Map(images)
  const calls: string[] = []
  return {
    calls,
    screenshot: async (_url, width, theme) => {
      const key = `${width}/${theme}`
      calls.push(key)
      const png = queues.get(key)?.shift()
      if (png === undefined) throw new Error(`no image for ${key}`)
      return png
    },
  }
}

async function optsWith(
  images: Map<string, Buffer[]>,
  extra: Partial<VisualCheckOpts> = {},
): Promise<VisualCheckOpts> {
  const outDir = await mkdtemp(join(tmpdir(), 'qare-visual-'))
  const { screenshot } = fakeScreenshot(images)
  return {
    baseUrl: BASE_URL,
    outDir,
    widths: [1440, 390],
    themes: ['light', 'dark'],
    revisions: ['base', 'head'],
    screenshot,
    ...extra,
  }
}

test('captures screenshots for every revision, width and theme combination', async () => {
  const opts = await optsWith(
    new Map([
      ['1440/light', [PNG_A, PNG_B]],
      ['1440/dark', [PNG_A, PNG_B]],
      ['390/light', [PNG_A, PNG_B]],
      ['390/dark', [PNG_A, PNG_B]],
    ]),
  )

  const result = await runVisualCheck(opts)

  expect(result.screenshots).toHaveLength(8)
  expect(result.screenshots.every((screenshot) => screenshot.outcome === 'captured')).toBe(true)
  for (const revision of ['base', 'head'] as const) {
    for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']] as const) {
      const path = join(opts.outDir, revision, `${width}x${theme}.png`)
      expect(existsSync(path), path).toBe(true)
    }
  }
})

test('byte-equal base and head pairs are identical without calling the differ', async () => {
  let differCalls = 0
  const opts = await optsWith(new Map([['1440/light', [PNG_A, PNG_A]]]), {
    widths: [1440],
    themes: ['light'],
    diffImages: async () => {
      differCalls += 1
      return PNG_C
    },
  })

  const result = await runVisualCheck(opts)

  expect(result.diffs).toEqual([{ width: 1440, theme: 'light', status: 'identical' }])
  expect(differCalls).toBe(0)
})

test('byte-different pairs call the differ and write a diff artifact', async () => {
  const opts = await optsWith(new Map([['1440/light', [PNG_A, PNG_B]]]), {
    widths: [1440],
    themes: ['light'],
    diffImages: async () => PNG_C,
  })

  const result = await runVisualCheck(opts)

  expect(result.diffs).toEqual([
    { width: 1440, theme: 'light', status: 'differs', path: join(opts.outDir, 'diff', '1440xlight.png') },
  ])
  expect(existsSync(join(opts.outDir, 'diff', '1440xlight.png'))).toBe(true)
})

test('a rejected screenshot is unverified, leaves no artifact and no diff claim', async () => {
  const opts = await optsWith(new Map([['1440/light', [PNG_A]]]), {
    widths: [1440],
    themes: ['light'],
    diffImages: async () => PNG_C,
  })

  const result = await runVisualCheck(opts)

  const unverified = result.screenshots.filter((screenshot) => screenshot.outcome === 'unverified')
  expect(unverified).toHaveLength(1)
  expect(unverified[0]?.revision).toBe('head')
  expect(unverified[0]?.reason).toContain('no image for 1440/light')
  expect(existsSync(join(opts.outDir, 'head', '1440xlight.png'))).toBe(false)
  expect(result.diffs).toEqual([])
})

test('without a screenshot backend every capture is unverified with a named reason', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'qare-visual-'))
  const result = await runVisualCheck({
    baseUrl: BASE_URL,
    outDir,
    widths: [1440],
    themes: ['light'],
    revisions: ['head'],
  })

  expect(result.screenshots).toEqual([
    {
      revision: 'head',
      width: 1440,
      theme: 'light',
      outcome: 'unverified',
      reason: 'no screenshot backend',
    },
  ])
})
