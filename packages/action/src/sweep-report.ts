import { findingDraft, statusDraft, statusReportMarker, sweepFindingMarker } from '@qare/core'
import type { SweepFinding, SweepPayload } from '@qare/core'
import { GitHubClient, GitHubClientError } from './github.js'

/**
 * The standing status report (#49): one issue, found by its marker and
 * updated in place, so a scheduled sweep keeps a current picture instead of
 * opening a pile of duplicates. The same marker pattern files sweep findings,
 * one issue per problem, mentioning the person whose change last touched the
 * ledger — the findings flow #154 gives the standing pipeline.
 */
export interface StatusReportUpdater {
  upsert(draft: { title: string; body: string }): Promise<number>
}

export class GitHubStatusReportUpdater implements StatusReportUpdater {
  private readonly client: GitHubClient

  constructor(client: GitHubClient) {
    this.client = client
  }

  async upsert(draft: { title: string; body: string }): Promise<number> {
    const marker = statusReportMarker()
    const hits = await this.client.searchIssues(`repo:${this.client.repository} in:body is:issue "${marker}"`)
    const existing = hits[0]
    if (existing !== undefined) {
      await this.client.patchIssueBody(existing.number, draft.body)
      return existing.number
    }
    const created = await this.client.createIssue(draft.title, draft.body)
    return created.number
  }
}

export async function publishSweep(
  client: GitHubClient,
  payload: SweepPayload,
): Promise<{ status: number; findings: Array<[string, number]> }> {
  const updater = new GitHubStatusReportUpdater(client)
  const status = await updater.upsert(statusDraft({ at: payload.at, classification: payload.classification }))
  const filed: Array<[string, number]> = []
  for (const finding of payload.findings) filed.push([finding.fingerprint, await fileSweepFinding(client, finding)])
  return { status, findings: filed }
}

export async function fileSweepFinding(client: GitHubClient, finding: SweepFinding): Promise<number> {
  const draft = findingDraft(finding)
  const hits = await client.searchIssues(`repo:${client.repository} in:body is:issue "${sweepFindingMarker(finding.fingerprint)}"`)
  const existing = hits[0]
  if (existing !== undefined) {
    await client.patchIssueBody(existing.number, draft.body)
    return existing.number
  }
  const created = await client.createIssue(draft.title, draft.body)
  return created.number
}

export function parseSweepPayload(input: unknown): SweepPayload {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new GitHubClientError('sweep payload must be a JSON object')
  const payload = input as Record<string, unknown>
  const at = payload.at
  if (typeof at !== 'string' || at === '') throw new GitHubClientError('sweep payload needs an "at" timestamp')
  const classification = parseClassification(payload.classification)
  const findings = Array.isArray(payload.findings) ? payload.findings.map(parseFinding) : []
  const lastActor = payload.lastActor
  return {
    at,
    ledger: typeof payload.ledger === 'string' ? payload.ledger : '.qa',
    classification,
    findings,
    lastActor: typeof lastActor === 'string' ? lastActor : undefined,
  }
}

function parseClassification(input: unknown): SweepPayload['classification'] {
  if (typeof input !== 'object' || input === null) throw new GitHubClientError('sweep payload needs a "classification" object')
  const source = input as Record<string, unknown>
  const buckets: Array<'proven' | 'stale' | 'unverified' | 'quarantined' | 'refused'> = [
    'proven',
    'stale',
    'unverified',
    'quarantined',
    'refused',
  ]
  const classification: SweepPayload['classification'] = {
    proven: [],
    stale: [],
    unverified: [],
    quarantined: [],
    refused: [],
  }
  for (const bucket of buckets) {
    const value = source[bucket]
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string'))
      throw new GitHubClientError(`sweep payload classification.${bucket} must be an array of criterion ids`)
    classification[bucket] = value.map((entry) => entry)
  }
  return classification
}

function parseFinding(input: unknown): SweepFinding {
  if (typeof input !== 'object' || input === null) throw new GitHubClientError('sweep finding must be a JSON object')
  const source = input as Record<string, unknown>
  if (typeof source.fingerprint !== 'string' || source.fingerprint === '')
    throw new GitHubClientError('sweep finding needs a "fingerprint"')
  if (typeof source.reason !== 'string' || source.reason === '') throw new GitHubClientError('sweep finding needs a "reason"')
  return { fingerprint: source.fingerprint, reason: source.reason, actor: typeof source.actor === 'string' ? source.actor : 'unknown' }
}
