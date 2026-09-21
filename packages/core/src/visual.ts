import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type VisualRevision = 'base' | 'head'

export interface VisualCheckOpts {
  baseUrl: string
  outDir: string
  widths: number[]
  themes: string[]
  revisions: VisualRevision[]
  screenshot?: (url: string, width: number, theme: string) => Promise<Buffer>
  diffImages?: (basePng: Buffer, headPng: Buffer) => Promise<Buffer | null>
}

export interface VisualScreenshot {
  revision: VisualRevision
  width: number
  theme: string
  path?: string
  outcome: 'captured' | 'unverified'
  reason?: string
}

export interface VisualDiff {
  width: number
  theme: string
  status: 'differs' | 'identical' | 'unavailable'
  path?: string
  reason?: string
}

export interface VisualCheckResult {
  screenshots: VisualScreenshot[]
  diffs: VisualDiff[]
}

export async function runVisualCheck(opts: VisualCheckOpts): Promise<VisualCheckResult> {
  const { baseUrl, outDir, widths, themes, revisions, screenshot, diffImages } = opts

  const screenshots: VisualScreenshot[] = []
  const captured = new Map<string, Partial<Record<VisualRevision, Buffer>>>()

  const buildUrl = (width: number, theme: string): string =>
    baseUrl + '?theme=' + encodeURIComponent(theme) + '&width=' + String(width)

  for (const revision of revisions) {
    for (const width of widths) {
      for (const theme of themes) {
        const entry = { width, theme }
        const key = `${width}|${theme}`
        const bucket = captured.get(key) ?? {}
        if (!screenshot) {
          screenshots.push({ revision, ...entry, outcome: 'unverified', reason: 'no screenshot backend' })
          captured.set(key, bucket)
          continue
        }
        try {
          const png = await screenshot(buildUrl(width, theme), width, theme)
          const path = join(outDir, revision, `${width}x${theme}.png`)
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, png)
          bucket[revision] = png
          captured.set(key, bucket)
          screenshots.push({ revision, ...entry, path, outcome: 'captured' })
        } catch (error) {
          captured.set(key, bucket)
          screenshots.push({ revision, ...entry, outcome: 'unverified', reason: String(error) })
        }
      }
    }
  }

  const diffs: VisualDiff[] = []
  for (const width of widths) {
    for (const theme of themes) {
      const bucket = captured.get(`${width}|${theme}`) ?? {}
      const basePng = bucket['base']
      const headPng = bucket['head']
      if (!basePng || !headPng) {
        continue
      }
      if (basePng.equals(headPng)) {
        diffs.push({ width, theme, status: 'identical' })
        continue
      }
      if (!diffImages) {
        diffs.push({ width, theme, status: 'unavailable', reason: 'no diff backend' })
        continue
      }
      try {
        const diffPng = await diffImages(basePng, headPng)
        if (diffPng == null) {
          diffs.push({ width, theme, status: 'unavailable', reason: 'the differ produced no image' })
          continue
        }
        const path = join(outDir, 'diff', `${width}x${theme}.png`)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, diffPng)
        diffs.push({ width, theme, status: 'differs', path })
      } catch (error) {
        diffs.push({ width, theme, status: 'unavailable', reason: String(error) })
      }
    }
  }

  return { screenshots, diffs }
}
