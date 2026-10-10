import { existsSync, readFileSync } from 'node:fs'
import type { HostKind } from './placement.js'
import type { RunnerSafetyFinding } from './runner-safety.js'
import { NARE_CONTRACT } from './runner.js'
import { VERSION } from './version.js'

/**
 * Where a run executed. `containerised` is the qare image (the image sets
 * `QARE_CONTAINER=1`, or its container leaves `/.dockerenv` where the rest of
 * the machine has none); `native` is a host qare is installed on. Both are
 * first class, and the evidence says which one produced it (issue #91).
 */
export type ExecutionKind = 'native' | 'containerised'

/**
 * The image a containerised run executed in (#88). The runner that pulled the
 * image passes its ref and digest through the environment, the image itself
 * names its flavour and the versions it pins, and the evidence names them all
 * so a run says which image digests produced it.
 */
export interface RunImage {
  name: string
  ref: string
  digest: string
  flavour?: string
  drivers?: Record<string, string>
  versions: {
    qare: string
    nare: string
    node: string
  }
}

/**
 * The version set that produced a run's evidence: qare itself, the node
 * runtime underneath it, and the nare machine contract the model seam spoke.
 */
export interface RunEnvironment {
  execution: ExecutionKind
  versions: {
    qare: string
    node: string
    nareContract: number
  }
  image?: RunImage
  /**
   * The kind of host that produced the result (#76): its operating system and
   * architecture, whether it offers hardware virtualisation, and the runner
   * it is when the run was placed on one. Absent in a result written before
   * the host was recorded.
   */
  host?: HostKind
  /** Bounded observations captured before repository code runs on a self-hosted job. */
  runnerSafety?: RunnerSafetyFinding[]
}

/**
 * Detect where qare is running. A containerised run is claimed only by
 * evidence the image can control: the `QARE_CONTAINER=1` it sets, or the
 * `/.dockerenv` a container root carries. Everything else is a host, so a
 * developer machine is `native` without any flag.
 */
export function detectExecution(env: NodeJS.ProcessEnv = process.env, containerFile = '/.dockerenv'): ExecutionKind {
  if (env.QARE_CONTAINER === '1') return 'containerised'
  if (existsSync(containerFile)) return 'containerised'
  return 'native'
}

/**
 * The image record a containerised run reports: the ref and digest the
 * runner that pulled the image passed in, the flavour the image sets, the
 * driver versions the flavour bakes beside its drivers, and the pinned
 * versions the image stamps at build time (`/opt/qare/config/IMAGE.json`).
 */
export function readRunImage(env: NodeJS.ProcessEnv = process.env, imageFile = '/opt/qare/config/IMAGE.json'): RunImage | undefined {
  const operational = env.QARE_IMAGE_REF
  const digest = env.QARE_IMAGE_DIGEST
  if (operational === undefined && digest === undefined) return undefined
  if (operational === undefined || digest === undefined)
    throw new Error('QARE_IMAGE_REF and QARE_IMAGE_DIGEST must be set together, so the evidence names the exact image that produced it')
  // QARE_IMAGE_REF is operational: nested cells use the same immutable
  // image. The optional release tag is display metadata only.
  const ref = env.QARE_IMAGE_TAG ?? operational
  const name = ref.includes('@') ? ref.split('@')[0] ?? ref : (ref.split(':')[0] ?? ref)
  const stamped = existsSync(imageFile) ? (JSON.parse(readFileSync(imageFile, 'utf8')) as unknown) : undefined
  const stampedVersions = (stamped !== undefined && typeof stamped === 'object' ? (stamped as Record<string, unknown>) : undefined) as
    | { qare?: string; nare?: string; node?: string }
    | undefined
  const drivers: Record<string, string> = {}
  for (const entry of (env.QARE_DRIVER_VERSIONS ?? '').split(/[ ,]+/)) {
    if (entry === '') continue
    const equals = entry.indexOf('=')
    if (equals > 0) drivers[entry.slice(0, equals)] = entry.slice(equals + 1)
  }
  const image: RunImage = {
    name,
    ref,
    digest,
    ...(env.QARE_FLAVOUR === undefined ? {} : { flavour: env.QARE_FLAVOUR }),
    ...(Object.keys(drivers).length === 0 ? {} : { drivers }),
    versions: {
      qare: stampedVersions?.qare ?? VERSION,
      nare: stampedVersions?.nare ?? String(NARE_CONTRACT),
      node: stampedVersions?.node ?? process.versions.node,
    },
  }
  return image
}

/** The environment record a run writes into its evidence (issue #91). */
export function runEnvironment(
  execution: ExecutionKind,
  env: NodeJS.ProcessEnv = process.env,
  imageFile = '/opt/qare/config/IMAGE.json',
  host?: HostKind,
): RunEnvironment {
  const image = execution === 'containerised' ? readRunImage(env, imageFile) : undefined
  return {
    execution,
    ...(host === undefined ? {} : { host }),
    versions: {
      qare: VERSION,
      node: process.versions.node,
      nareContract: NARE_CONTRACT,
    },
    ...(image === undefined ? {} : { image }),
  }
}
