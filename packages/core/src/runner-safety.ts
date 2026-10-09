import { accessSync, constants, readFileSync } from 'node:fs'
import { connect } from 'node:net'

export const RUNNER_CHECKLIST_ITEMS = ['ephemeral', 'docker', 'execute-pool', 'network', 'credentials', 'image-digest'] as const
export type RunnerChecklistItem = (typeof RUNNER_CHECKLIST_ITEMS)[number]

/** Observations are warnings, never a claim that the external runner is safe. */
export interface RunnerSafetyFinding {
  checklist: RunnerChecklistItem
  status: 'finding' | 'unobservable'
  detail: string
}

export interface RunnerSafetyProbes {
  readable?: (path: string) => boolean
  reachable?: (host: string, port: number) => Promise<boolean>
}

const UNKNOWN: Record<RunnerChecklistItem, string> = {
  ephemeral: 'cannot observe one-job destruction from inside this job; inspect the runner controller and destruction logs',
  docker: 'cannot observe exclusive Docker daemon ownership from inside this job; verify the daemon and storage belong only to this job',
  'execute-pool': 'cannot observe pool membership or sandbox enforcement from inside this job; inspect runner groups and runtime configuration',
  network: 'cannot observe the complete network boundary from inside this job; inspect firewall policy and test denied internal destinations',
  credentials: 'cannot observe credentials outside this process environment and known readable paths; audit the runner environment and mounts',
  'image-digest': 'cannot observe the runner controller image pull from inside this job; inspect its digest-pinned image specification',
}

/** Only names are recorded. Values and credential file contents never enter evidence. */
const CREDENTIAL_NAME = /^(?:AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|AZURE_(?:CLIENT_SECRET|CLIENT_CERTIFICATE_PASSWORD)|GOOGLE_(?:APPLICATION_CREDENTIALS|CREDENTIALS)|CLOUDSDK_AUTH_ACCESS_TOKEN|KUBE(?:CONFIG|_TOKEN)|(?:DOCKER|REGISTRY|GHCR|GITHUB|GH|OPENAI|ANTHROPIC)_(?:AUTH_CONFIG|PASSWORD|TOKEN|KEY|API_KEY))$/i
const CREDENTIAL_FILES = ['service-account-token', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'KUBECONFIG', 'HOME/.docker/config.json', 'HOME/.aws/credentials', 'HOME/.kube/config', 'HOME/.config/gcloud/application_default_credentials.json']

/** The host step forwards observations only, so a container cannot hide host credentials. */
function snapshotFindings(path: string): RunnerSafetyFinding[] {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const invalid = (): never => { throw new Error('invalid runner safety snapshot: expected schema 1, known credential names and files, and boolean reachability observations') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const data = value as Record<string, unknown>
  if (data.schemaVersion !== '1' || !Array.isArray(data.credentialVariables) || !Array.isArray(data.credentialFiles) || typeof data.clusterReachable !== 'boolean' || typeof data.remoteDocker !== 'boolean') return invalid()
  const findings: RunnerSafetyFinding[] = []
  for (const name of data.credentialVariables) {
    if (typeof name !== 'string' || !CREDENTIAL_NAME.test(name)) return invalid()
    findings.push({ checklist: 'credentials', status: 'finding', detail: `credential environment variable ${name} is present on the runner; remove it from execute` })
  }
  for (const name of data.credentialFiles) {
    if (typeof name !== 'string' || !CREDENTIAL_FILES.includes(name)) return invalid()
    findings.push({ checklist: 'credentials', status: 'finding', detail: `credential file ${name} is readable on the runner; remove its mount or configuration from execute` })
  }
  if (data.clusterReachable) findings.push({ checklist: 'network', status: 'finding', detail: 'the cluster API is reachable from the runner; deny internal services from the execute pool' })
  if (data.remoteDocker) findings.push({ checklist: 'docker', status: 'finding', detail: 'a remote Docker daemon is reachable from the runner; verify it belongs only to this job' })
  return findings
}

export async function inspectRunnerSafety(env: NodeJS.ProcessEnv = process.env, probes: RunnerSafetyProbes = {}): Promise<RunnerSafetyFinding[] | undefined> {
  if ((env.QARE_RUNNER_ENVIRONMENT ?? env.RUNNER_ENVIRONMENT) !== 'self-hosted') return undefined
  const readable = probes.readable ?? isReadable
  const reachable = probes.reachable ?? canConnect
  const findings: RunnerSafetyFinding[] = RUNNER_CHECKLIST_ITEMS.map(checklist => ({ checklist, status: 'unobservable', detail: UNKNOWN[checklist] }))
  const warn = (checklist: RunnerChecklistItem, detail: string): void => { findings.push({ checklist, status: 'finding', detail }) }
  if (env.QARE_RUNNER_SAFETY_FILE !== undefined) findings.push(...snapshotFindings(env.QARE_RUNNER_SAFETY_FILE))

  for (const name of Object.keys(env).sort()) {
    if (env[name] !== undefined && env[name] !== '' && CREDENTIAL_NAME.test(name)) warn('credentials', `credential environment variable ${name} is present; remove it from execute`)
  }
  // Never read contents. Checking accessibility suffices to report exposure.
  const token = '/var/run/secrets/kubernetes.io/serviceaccount/token'
  if (readable(token)) warn('credentials', `mounted service account token is readable at ${token}; disable automatic service account token mounts`)
  for (const name of ['AWS_WEB_IDENTITY_TOKEN_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'KUBECONFIG']) {
    const path = env[name]
    if (path !== undefined && path !== '' && readable(path)) warn('credentials', `credential file named by ${name} is readable; remove its mount from execute`)
  }
  if (env.HOME !== undefined) {
    for (const path of ['.docker/config.json', '.aws/credentials', '.kube/config', '.config/gcloud/application_default_credentials.json']) {
      if (readable(`${env.HOME}/${path}`)) warn('credentials', `credential configuration ${path} is readable under HOME; remove it from execute`)
    }
  }

  const cluster = env.KUBERNETES_SERVICE_HOST
  const clusterPort = portNumber(env.KUBERNETES_SERVICE_PORT ?? '443')
  if (cluster !== undefined && cluster !== '' && clusterPort !== undefined && await reachable(cluster, clusterPort)) {
    warn('network', 'the cluster API address named by KUBERNETES_SERVICE_HOST is reachable; deny access to internal services from the execute pool')
  }
  // A remote daemon is a visible boundary worth checking, not proof of sharing.
  try {
    const endpoint = new URL(env.DOCKER_HOST ?? '')
    const port = portNumber(endpoint.port || (endpoint.protocol === 'https:' ? '2376' : '2375'))
    if (['tcp:', 'http:', 'https:'].includes(endpoint.protocol) && port !== undefined && await reachable(endpoint.hostname, port)) {
      warn('docker', 'a remote Docker daemon is reachable through DOCKER_HOST; verify it is dedicated to this job and never shared with jobs holding secrets')
    }
  } catch { /* No remote endpoint was named. Local sockets still require an operator audit. */ }
  return findings
}

function portNumber(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return port > 0 && port <= 65535 ? port : undefined
}

function isReadable(path: string): boolean {
  try { accessSync(path, constants.R_OK); return true } catch { return false }
}

/** A TCP handshake sends no credentials and is bounded even on a filtered network. */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => done(false), 500)
    const done = (reachable: boolean): void => { clearTimeout(timer); socket.destroy(); resolve(reachable) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
