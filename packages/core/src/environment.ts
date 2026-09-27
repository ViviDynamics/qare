import { existsSync } from 'node:fs'
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

/** The environment record a run writes into its evidence (issue #91). */
export function runEnvironment(execution: ExecutionKind): RunEnvironment {
  return {
    execution,
    versions: {
      qare: VERSION,
      node: process.versions.node,
      nareContract: NARE_CONTRACT,
    },
  }
}
