import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type VisualRevision = 'base' | 'head'

export interface VisualCheckOpts {
  baseUrl: string
  outDir: string
  widths: number[]
  themes: string[]
  revisions: VisualRevision[]
  screenshot?: (url: string, width: number, theme: string, revision: VisualRevision) => Promise<Buffer>
  diffImages?: (basePng: Buffer, headPng: Buffer) => Promise<Buffer | null>
  /**
   * Profile masks (#119): page regions the screenshot backend blacks out at
   * capture. They come from the profile, so base and head screenshots carry
   * the same masks and masking never shows as a visual difference.
   */
  masks?: string[]
}

export interface VisualScreenshot {
  revision: VisualRevision
  width: number
  theme: string
  path?: string
  outcome: 'captured' | 'unverified'
  reason?: string
  /** The masks that were in force for this screenshot (#119). */
  masks?: string[]
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
  const { baseUrl, outDir, widths, themes, revisions, screenshot, diffImages, masks } = opts

  const screenshots: VisualScreenshot[] = []
  const captured = new Map<string, Partial<Record<VisualRevision, Buffer>>>()

  const buildUrl = (width: number, theme: string): string => {
    const separator = baseUrl.includes('?') ? '&' : '?'
    return baseUrl + separator + 'theme=' + encodeURIComponent(theme) + '&width=' + String(width)
  }

  for (const revision of revisions) {
    for (const width of widths) {
      for (const theme of themes) {
        const entry = { width, theme }
        const key = `${width}|${theme}`
        const bucket = captured.get(key) ?? {}
        if (!screenshot) {
          screenshots.push({ revision, ...entry, outcome: 'unverified', reason: 'no screenshot backend' })
          continue
        }
        try {
          const png = await screenshot(buildUrl(width, theme), width, theme, revision)
          const path = join(outDir, revision, `${width}x${theme}.png`)
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, png)
          bucket[revision] = png
          captured.set(key, bucket)
          screenshots.push({ revision, ...entry, ...(masks === undefined ? {} : { masks }), path, outcome: 'captured' })
        } catch (error) {
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
        const missing = basePng === undefined ? 'base' : 'head'
        diffs.push({
          width,
          theme,
          status: 'unavailable',
          reason: `${missing} screenshot not captured; no diff can be produced`,
        })
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
