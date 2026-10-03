import { readFile } from 'node:fs/promises'
import { integrityOf, parseLedgerEntries } from '@qare/core'
import type { GitHubClient } from './github.js'
import { APP_ID_ENV, APP_PRIVATE_KEY_ENV, PERSONAL_TOKEN_ENV } from './identity.js'

export class IngestDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IngestDeliveryError'
  }
}

export interface IngestProposalPayload {
  ledgerPath: string
  baseFingerprint: string
  ledgerText: string
  branch: string
  title: string
  body: string
}

export interface IngestCommentPayload {
  issue: number
  marker: string
  body: string
}

export interface IngestDelivery {
  pull: { number: number; htmlUrl?: string }
  postedComments: number[]
  skippedComments: number[]
  alreadyProposed: boolean
}

/**
 * Deliver an ingest payload: verify the ledger has not moved since ingest
 * ran, commit the proposed ledger to a content-addressed branch, open the
 * pull request that asks a human to apply it, and post each uncheckable
 * comment once.
 *
 * The same payload delivered twice is one proposal: the branch is named for
 * the resulting ledger's fingerprint, a pull request that already exists is
 * reported rather than reopened, and a comment whose marker is already on the
 * issue is left alone. The one thing the delivery refuses is a stale payload,
 * because a proposal built on a ledger that has since moved would silently
 * drop whatever moved in between.
 *
 * A proposal is never opened with the Actions token (#61): a pull request
 * that token opens triggers no workflows, so it would reach its reviewer
 * with no checks on it. The delivery stops before it writes anything and
 * names the two identities that can open one.
 */
export async function deliverIngest(opts: {
  proposalPath: string
  commentsPath?: string
  base: string
  client: GitHubClient
}): Promise<IngestDelivery> {
  if (opts.client.identity.kind === 'actions') {
    throw new IngestDeliveryError(
      `a pull request opened with the Actions token (GITHUB_TOKEN) triggers no workflows, so this proposal would arrive with no checks: open it as the GitHub App (${APP_ID_ENV} and ${APP_PRIVATE_KEY_ENV}) or with a personal access token (${PERSONAL_TOKEN_ENV})`,
    )
  }
  const proposal = parseProposalPayload(JSON.parse(await readFile(opts.proposalPath, 'utf8')))
  const comments = opts.commentsPath === undefined ? [] : parseCommentPayload(JSON.parse(await readFile(opts.commentsPath, 'utf8')))

  const current = await opts.client.getContents(proposal.ledgerPath, opts.base)
  const currentEntries = current === undefined ? [] : parseLedgerEntries(JSON.parse(current.toString('utf8')))
  if (integrityOf(currentEntries) !== proposal.baseFingerprint) {
    throw new IngestDeliveryError(
      `the ledger on ${opts.base} does not match the one ingest ran against (${proposal.baseFingerprint}): re-run ingest against the current ledger`,
    )
  }

  const head = await opts.client.getBranchHead(opts.base)
  if (head === undefined) throw new IngestDeliveryError(`the base branch ${opts.base} has no head to build on`)
  if ((await opts.client.getBranchHead(proposal.branch)) === undefined) {
    const blob = await opts.client.createBlob(Buffer.from(proposal.ledgerText, 'utf8'))
    const baseTree = await opts.client.getCommitTree(head)
    const tree = await opts.client.createTree(
      [{ path: proposal.ledgerPath, mode: '100644' as const, type: 'blob' as const, sha: blob }],
      baseTree,
    )
    const commit = await opts.client.createCommit(proposal.title, tree, [head])
    await opts.client.pushBranch(proposal.branch, commit, undefined)
  }

  let pull: { number: number; htmlUrl?: string }
  let alreadyProposed: boolean
  try {
    pull = await opts.client.createPullRequest(proposal.branch, opts.base, proposal.title, proposal.body)
    alreadyProposed = false
  } catch (error) {
    const status = error instanceof Error && 'status' in error ? (error as { status?: number }).status : undefined
    const message = error instanceof Error ? error.message : String(error)
    if (status !== 422 || !/already exists/i.test(message)) throw error
    alreadyProposed = true
    pull = { number: 0 }
  }

  const postedComments: number[] = []
  const skippedComments: number[] = []
  for (const comment of comments) {
    const bodies = (await opts.client.listIssueComments(comment.issue)).map((entry) => entry.body ?? '')
    if (bodies.some((body) => body.includes(comment.marker))) {
      skippedComments.push(comment.issue)
      continue
    }
    await opts.client.postIssueComment(comment.issue, comment.body)
    postedComments.push(comment.issue)
  }

  return { pull, postedComments, skippedComments, alreadyProposed }
}

function parseProposalPayload(parsed: unknown): IngestProposalPayload {
  if (typeof parsed !== 'object' || parsed === null) throw new IngestDeliveryError('ingest proposal payload must be a JSON object')
  const record = parsed as Record<string, unknown>
  const payload: Record<string, string> = {}
  for (const field of ['ledgerPath', 'baseFingerprint', 'ledgerText', 'branch', 'title', 'body'] as const) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '')
      throw new IngestDeliveryError(`ingest proposal: ${field} must be a non-empty string`)
    payload[field] = record[field] as string
  }
  return payload as unknown as IngestProposalPayload
}

function parseCommentPayload(parsed: unknown): IngestCommentPayload[] {
  if (!Array.isArray(parsed)) throw new IngestDeliveryError('ingest comments must be a JSON array')
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null)
      throw new IngestDeliveryError(`ingest comments[${index}] must be an object`)
    const record = entry as Record<string, unknown>
    if (!Number.isInteger(record.issue) || (record.issue as number) <= 0)
      throw new IngestDeliveryError(`ingest comments[${index}].issue must be a positive integer`)
    for (const field of ['marker', 'body'] as const) {
      if (typeof record[field] !== 'string' || (record[field] as string).trim() === '')
        throw new IngestDeliveryError(`ingest comments[${index}].${field} must be a non-empty string`)
    }
    return { issue: record.issue as number, marker: record.marker as string, body: record.body as string }
  })
}
