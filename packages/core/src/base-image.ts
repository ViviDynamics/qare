import { spawn } from 'node:child_process'
import { BASE_IMAGE_COMMIT } from './profile.js'

/**
 * A prebuilt image for the base side (#381). The profile names it
 * (`base.image`), never the model. The run pulls it and reads the commit it
 * says it was built from, the `org.opencontainers.image.revision` label
 * (the label `docker/metadata-action` writes); only an image whose label is
 * the base commit stands in for the base side's build. Anything else (a pull
 * that fails, no label, another commit) leaves the base to be built from the
 * base tree as before, and the record says why, so a wrong image can never
 * stand in for the base and a missing one costs only the time it would
 * have saved.
 */

export const REVISION_LABEL = 'org.opencontainers.image.revision'

/** What the base side did with the image the profile named: which it was, what it resolved to, and whether it ran. */
export interface BaseImageRecord {
  /** The reference pulled, with `{base}` replaced. */
  ref: string
  used: boolean
  /** The registry digest the pull resolved to, when the image has one. */
  digest?: string
  /** The commit the image's revision label names. */
  revision?: string
  /** Why it was not used. */
  reason?: string
}

/** Runs `docker` with these arguments. A seam: the boot's docker by default. */
export type RunDocker = (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>

/** How long a pull may take before the base is built instead. */
export const BASE_IMAGE_PULL_TIMEOUT_MS = 10 * 60_000

/** The reference as written, with `{base}` replaced by the full base commit. */
export function baseImageRef(written: string, baseCommit: string): string {
  return written.replaceAll(BASE_IMAGE_COMMIT, baseCommit)
}

const BUILT_INSTEAD = 'the base side was built from the base tree'

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

/** Pull the image the profile named, and say whether it is the base commit's. Never throws. */
export async function resolveBaseImage(written: string, baseCommit: string | undefined, runDocker: RunDocker = defaultRunDocker): Promise<BaseImageRecord> {
  if (baseCommit === undefined)
    return { ref: written, used: false, reason: `the base commit is not known, so no image can be shown to be built from it; ${BUILT_INSTEAD}` }
  const ref = baseImageRef(written, baseCommit)
  try {
    const pulled = await runDocker(['pull', '--', ref], BASE_IMAGE_PULL_TIMEOUT_MS)
    if (pulled.code !== 0) {
      const said = firstLine(pulled.stderr) || firstLine(pulled.stdout)
      return { ref, used: false, reason: `the image could not be pulled (docker pull exited ${pulled.code}${said === '' ? '' : `: ${said}`}), so ${BUILT_INSTEAD}` }
    }
  } catch (error) {
    return { ref, used: false, reason: `the image could not be pulled (${String(error)}), so ${BUILT_INSTEAD}` }
  }
  let image: { digest?: string; revision?: string }
  try {
    const inspected = await runDocker(['image', 'inspect', '--', ref], 60_000)
    if (inspected.code !== 0) throw new Error(`docker image inspect exited ${inspected.code}: ${firstLine(inspected.stderr)}`)
    image = readInspect(JSON.parse(inspected.stdout) as unknown)
  } catch (error) {
    return { ref, used: false, reason: `the pulled image could not be inspected (${error instanceof Error ? error.message : String(error)}), so ${BUILT_INSTEAD}` }
  }
  const named = { ref, ...(image.digest === undefined ? {} : { digest: image.digest }), ...(image.revision === undefined ? {} : { revision: image.revision }) }
  if (image.revision === undefined)
    return { ...named, used: false, reason: `the image carries no ${REVISION_LABEL} label, so it cannot show it was built from the base commit; ${BUILT_INSTEAD}` }
  if (image.revision.toLowerCase() !== baseCommit.toLowerCase())
    return { ...named, used: false, reason: `the image says it was built from ${image.revision}, not the base commit ${baseCommit}, so ${BUILT_INSTEAD}` }
  return { ...named, used: true }
}

function readInspect(value: unknown): { digest?: string; revision?: string } {
  const first = Array.isArray(value) ? (value[0] as unknown) : undefined
  if (typeof first !== 'object' || first === null) throw new Error('docker image inspect answered with no image')
  const image = first as { RepoDigests?: unknown; Config?: { Labels?: unknown } }
  const digest = Array.isArray(image.RepoDigests) && typeof image.RepoDigests[0] === 'string' ? image.RepoDigests[0] : undefined
  const labels = image.Config?.Labels
  const label = typeof labels === 'object' && labels !== null ? (labels as Record<string, unknown>)[REVISION_LABEL] : undefined
  const revision = typeof label === 'string' && label.trim() !== '' ? label.trim() : undefined
  return { ...(digest === undefined ? {} : { digest }), ...(revision === undefined ? {} : { revision }) }
}

/** The runner's docker, killed at its deadline. */
export function defaultRunDocker(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: killed ? -1 : (code ?? -1), stdout, stderr: killed ? `${stderr}docker ${args[0] ?? ''} exceeded its bound of ${Math.round(timeoutMs / 1000)}s` : stderr })
    })
  })
}
