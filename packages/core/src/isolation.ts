import { randomUUID } from 'node:crypto'
import { createServer, type ListenOptions } from 'node:net'

/**
 * Per-run compose isolation (#53). Every run boots its app under a unique
 * compose project, so project name, network and volumes belong to that run
 * alone, and the app's published host port is allocated per run, so two runs
 * never bind the same one.
 */
export interface RunIsolation {
  runId: string
  /** The compose project name: `qare-<run id>`. The `qare-` prefix is what `qare reap` scans for. */
  project: string
  startedAt: string
  /** The host port allocated for the app; a run that boots nothing has none. */
  port?: number
}

/**
 * The local hosts a published compose port is reachable on. A health URL
 * naming one of these (with an explicit port) is pinned to the run's port.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Mint the isolation a run boots under: a fresh run id, the compose project
 * named after it, and a free host port for the app. Allocation failure throws,
 * so the run is refused with the reason named rather than booted unisolated.
 */
export async function isolateRun(): Promise<RunIsolation> {
  const runId = randomUUID()
  return {
    runId,
    project: `qare-${runId}`,
    startedAt: new Date().toISOString(),
    port: await allocatePort(),
  }
}

/**
 * A bare project isolation for a compose call whose caller does not own a run:
 * the project alone keeps concurrent boots out of each other's networks and
 * volumes. No port is allocated, so nothing about where the app is published
 * changes for a caller that did not ask for it.
 */
export function mintIsolation(): RunIsolation {
  const runId = randomUUID()
  return { runId, project: `qare-${runId}`, startedAt: new Date().toISOString() }
}

/** Bind port 0 on the loopback interface and report the port the OS handed back. */
export function allocatePort(): Promise<number> {
  const options: ListenOptions = { host: '127.0.0.1', port: 0, exclusive: true }
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(options, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(() => {
        if (port === undefined) reject(new Error('the OS reported no port for an ephemeral bind'))
        else resolve(port)
      })
    })
  })
}

/**
 * Pin a local health URL to the port this run published its app on, so the
 * health check, and every check the run drives, probes the app this run booted
 * rather than another run's. A URL that is not local, carries no explicit
 * port, or does not parse, is returned unchanged: qare rewrites only what it
 * can name, and the boot names the URL when its probe does not answer.
 */
export function isolatedHealthUrl(url: string, port: number | undefined): string {
  if (port === undefined) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url
  if (!LOCAL_HOSTS.has(parsed.hostname) || parsed.port === '') return url
  parsed.port = String(port)
  return parsed.toString()
}

/**
 * The compose environment a run hands to every compose invocation: the port the
 * app is published on, and the run id for labeling. Profile compose files bind
 * the port with `ports: ["${QARE_APP_PORT:-3000}:3000"]` so two concurrent runs
 * never collide on the host.
 */
export function composeEnv(isolation: RunIsolation | undefined): Record<string, string> | undefined {
  if (isolation === undefined) return undefined
  return {
    QARE_RUN_ID: isolation.runId,
    ...(isolation.port === undefined ? {} : { QARE_APP_PORT: String(isolation.port) }),
  }
}
