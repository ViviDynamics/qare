import type { CriterionResult, RunResult, RunVerdict } from './result.js'

export interface CheckRunPayload {
  title: string
  summary: string
  conclusion: 'success' | 'failure' | 'neutral'
}

export interface EvidencePoster {
  postComment(body: string): Promise<void>
  createCheckRun(payload: CheckRunPayload): Promise<void>
}

const CHECK_RUN_CONCLUSIONS: Record<RunVerdict, CheckRunPayload['conclusion']> = {
  passed: 'success',
  failed: 'failure',
  blocked: 'neutral',
  refused: 'neutral',
  waived: 'neutral',
}

function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ')
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function failedReason(criterion: CriterionResult): string {
  if (criterion.outcome === 'failed' && 'reason' in criterion && typeof criterion.reason === 'string')
    return criterion.reason
  return ''
}

function reasonCell(criterion: CriterionResult): string {
  if (criterion.outcome === 'unverified') {
    if (typeof criterion.reason === 'string' && criterion.reason.startsWith('waived by '))
      return `waived (human): ${criterion.reason}`
    return `could not verify (environment): ${criterion.reason}`
  }
  return failedReason(criterion)
}

function detailLinks(criteria: CriterionResult[]): string[] {
  const lines: string[] = []
  for (const criterion of criteria) {
    const links = (criterion.evidence ?? [])
      .filter(path => path !== '')
      // angle brackets keep destinations intact for paths with spaces or parens
      .map(path => `[${escapeLinkText(basename(path))}](<${path}>)`)
    if (links.length > 0) lines.push(`- ${escapeLinkText(criterion.id)}: ${links.join(', ')}`)
  }
  return lines
}

function escapeLinkText(text: string): string {
  return text.replace(/[\[\]]/g, ' ')
}

export function renderComment(result: RunResult): string {
  const job = result.job === undefined ? '' : ` (job ${result.job.id})`
  const lines = [
    `## QARE run: ${result.verdict}${job}`,
    '',
    '| criterion | outcome | reason |',
    '| --- | --- | --- |',
    ...result.criteria.map(
      criterion =>
        `| ${escapeCell(criterion.id)} | ${criterion.outcome} | ${escapeCell(reasonCell(criterion))} |`,
    ),
  ]
  const details = detailLinks(result.criteria)
  if (details.length > 0) lines.push('', 'Details:', '', ...details)
  const unverified = result.criteria.filter(criterion => criterion.outcome === 'unverified')
  if (unverified.length > 0) {
    if (unverified.every(criterion => typeof criterion.reason === 'string' && criterion.reason.startsWith('waived by ')))
      lines.push(
        '',
        'Waived criteria are recorded as waived (human) — a waiver is not a pass and needs out-of-band confirmation.',
      )
    else
      lines.push(
        '',
        'Unverified criteria could not verify (environment) — that is not a code defect.',
      )
  }
  return lines.join('\n')
}

export function renderCheckRun(result: RunResult): CheckRunPayload {
  const counts = { proven: 0, failed: 0, unverified: 0 }
  for (const criterion of result.criteria) counts[criterion.outcome] += 1
  return {
    title: 'QARE',
    summary: `verdict ${result.verdict}: ${counts.proven} proven, ${counts.failed} failed, ${counts.unverified} unverified`,
    conclusion: CHECK_RUN_CONCLUSIONS[result.verdict],
  }
}
