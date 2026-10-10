import type { AdvisoryFinding, RunAdvisory } from './advisory.js'
import { codeSpan, uploadedScreenshotLink, type EvidenceLinks } from './evidence.js'

/** The replies a person acts on a finding with (#150). Each names the finding by id. */
export const ADVISORY_DISMISS_COMMAND = '/qa-dismiss'
export const ADVISORY_PROMOTE_COMMAND = '/qa-promote'

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * Where a finding's screenshot can be opened from. Beside the evidence the
 * path resolves. On a pull request only a screenshot that was pushed is
 * linked; any other is named and held by the artifact (rule 4).
 */
function screenshotLine(path: string, links: EvidenceLinks): string {
  const name = basename(path).replace(/[\[\]]/g, ' ')
  if (links.kind === 'relative') return `[${name}](<${path}>)`
  const url = links.screenshots?.[path]
  return url === undefined ? codeSpan(path) : uploadedScreenshotLink(path, url)
}

function findingLines(finding: AdvisoryFinding, links: EvidenceLinks): string[] {
  const element = finding.element === undefined ? '' : `, element ${codeSpan(finding.element)}`
  return [
    // The severity and category come from fixed lists; everything a model or
    // a path wrote is a code span, where nothing renders.
    `- **${finding.severity}** ${codeSpan(finding.id)} (${finding.category}) on ${codeSpan(finding.screen)}${element}`,
    `  - Saw: ${codeSpan(finding.saw)}`,
    `  - Why it matters: ${codeSpan(finding.why)}`,
    ...(finding.screenshot === undefined ? [] : [`  - Screenshot: ${screenshotLine(finding.screenshot, links)}`]),
  ]
}

/**
 * The advisory section of the comment (#150): what the UX reviewer reported,
 * in a section of its own that says what it is. The findings are a model's
 * opinion, so the section says they are not evidence and that the verdict was
 * decided without them, and it sits below everything the verdict rests on. A
 * posted comment says how to dismiss a finding and how to file one as an
 * issue; qare does neither unasked.
 */
export function renderAdvisorySection(advisory: RunAdvisory, links: EvidenceLinks): string[] {
  const lines = ['', '## Advisory UX review', '']
  if (advisory.status === 'unavailable') {
    lines.push(`The advisory UX review did not answer (${codeSpan(advisory.reason ?? 'no reason was recorded')}), so it has no findings. The verdict does not depend on it.`)
    return lines
  }
  lines.push(
    `Advisory: a model read what the run saw of ${counted(advisory.screens.length, 'screen', 'screens')} (the action logs and accessibility snapshots, not the pixels) and reports what a person using them might trip over. These findings are opinions for a reviewer to read. They are not evidence, they prove and fail nothing, and the verdict above was decided without them.`,
  )
  if (advisory.findings.length === 0) lines.push('', 'It reported nothing.')
  else lines.push('', ...advisory.findings.flatMap((finding) => findingLines(finding, links)))
  const dismissed = advisory.dismissed?.length ?? 0
  if (dismissed > 0)
    lines.push('', `${counted(dismissed, 'finding', 'findings')} a person dismissed on this pull request ${dismissed === 1 ? 'was' : 'were'} not raised again.`)
  const first = advisory.findings[0]
  if (links.kind === 'artifact' && first !== undefined)
    lines.push(
      '',
      `Reply ${codeSpan(`${ADVISORY_DISMISS_COMMAND} ${first.id}`)} to stop a finding being raised again on this pull request, or ${codeSpan(`${ADVISORY_PROMOTE_COMMAND} ${first.id}`)} to file it as an issue, each with the finding's own id. qare files no issue unless asked.`,
    )
  return lines
}
