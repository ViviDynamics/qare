import { renderAdvisorySection } from './advisory-comment.js'
import { describeHost, describeRequirements, type HostKind, type Requirements } from './placement.js'
import type { CriterionResult, RunResult, RunVerdict } from './result.js'

export interface CheckRunPayload {
  title: string
  summary: string
  conclusion: 'success' | 'failure' | 'neutral'
}

/**
 * Where the comment's evidence lives, which decides what it may link to.
 *
 * `relative`: the comment is read beside the evidence directory (qare judge's
 * comment.md), so relative links resolve. `artifact`: the comment is posted on
 * a pull request, where a relative path resolves to nothing; files are named,
 * and the only link is to the run's evidence artifact, when one was uploaded.
 * `screenshots` holds the evidence paths the run's screenshots were pushed to
 * the `qa-assets` branch for, keyed by evidence path and valued at the branch
 * link; those outlive the artifact. Nothing links to a file that is not there
 * to open (CONSTITUTION rule 4), so a screenshot is linked only when it was
 * actually pushed, and every other file stays named but held by the artifact.
 */
export type EvidenceLinks =
  | { kind: 'relative' }
  | { kind: 'artifact'; url?: string | undefined; screenshots?: Record<string, string> | undefined }

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

type UnverifiedCause = 'waived' | 'quarantine' | 'verifier' | 'environment'

// judge names the cause at the start of the reason: a human waiver, or the
// verifier being unable to check what the checks proved. Anything else is the
// environment, which is where every other unverified criterion comes from.
function unverifiedCause(criterion: CriterionResult): UnverifiedCause {
  const reason = 'reason' in criterion && typeof criterion.reason === 'string' ? criterion.reason : ''
  if (reason.startsWith('waived by ')) return 'waived'
  if (reason.startsWith('quarantined (')) return 'quarantine'
  if (reason.startsWith('verifier ')) return 'verifier'
  return 'environment'
}

function outcomeReason(criterion: CriterionResult): string {
  if (criterion.outcome === 'unverified') {
    const cause = unverifiedCause(criterion)
    if (cause === 'waived') return `waived (human): ${criterion.reason}`
    if (cause === 'quarantine') return `quarantined (flake): ${criterion.reason}`
    if (cause === 'verifier') return `not independently checked: ${criterion.reason}`
    return `could not verify (environment): ${criterion.reason}`
  }
  return failedReason(criterion)
}

const REGRESSION = 'regression: proven at the base, failed at the head'

/**
 * What the base side says about a criterion (#147), in the words the table
 * shows. A regression is named as one; a failure that failed at the base too
 * is named as behaviour that does not work yet; a criterion the base side
 * left out is not compared, with its reason. When the whole base side did
 * not run the comment says so once, above the table, and the rows stay quiet.
 */
function comparisonNote(criterion: CriterionResult, baseRan: boolean): string {
  if (criterion.regression === true)
    return criterion.outcome === 'failed' ? REGRESSION : `${REGRESSION}, which a waiver does not cover`
  if (criterion.regression === false) return 'not a regression: it failed at the base too, so this is behaviour that does not work yet'
  if (baseRan && criterion.base?.outcome === 'not-compared') return `not compared with the base: ${criterion.base.reason ?? 'no reason was recorded'}`
  return ''
}

function reasonCell(criterion: CriterionResult, baseRan: boolean): string {
  return [outcomeReason(criterion), comparisonNote(criterion, baseRan)].filter((part) => part !== '').join('; ')
}

/** A regression rests on two pieces of evidence: what the base saved for it is listed beside the head's. */
function regressionBaseEvidence(criterion: CriterionResult): string[] {
  return criterion.regression === true ? (criterion.base?.evidence ?? []).filter((path) => path !== '') : []
}

function detailLinks(criteria: CriterionResult[]): string[] {
  const lines: string[] = []
  for (const criterion of criteria) {
    const links = (criterion.evidence ?? [])
      .filter(path => path !== '')
      // angle brackets keep destinations intact for paths with spaces or parens
      .map(path => `[${escapeLinkText(basename(path))}](<${path}>)`)
    if (links.length > 0) lines.push(`- ${escapeLinkText(criterion.id)}: ${links.join(', ')}`)
    const atBase = regressionBaseEvidence(criterion).map(path => `[${escapeLinkText(basename(path))}](<${path}>)`)
    if (atBase.length > 0) lines.push(`- ${escapeLinkText(criterion.id)} at the base: ${atBase.join(', ')}`)
  }
  return lines
}

function detailNames(criteria: CriterionResult[], screenshots: Record<string, string> | undefined): string[] {
  const lines: string[] = []
  for (const criterion of criteria) {
    const names = (criterion.evidence ?? [])
      .filter(path => path !== '')
      .map(path => {
        const url = screenshots?.[path]
        // A pushed screenshot keeps resolving after the artifact expires; the
        // link is written only for the file that was pushed (rule 4).
        return url === undefined ? codeSpan(path) : `[${escapeLinkText(basename(path))}](<${url}>)`
      })
    if (names.length > 0) lines.push(`- ${codeSpan(criterion.id)}: ${names.join(', ')}`)
    // Base evidence is named, never linked: only head screenshots are pushed.
    const atBase = regressionBaseEvidence(criterion).map(path => codeSpan(path))
    if (atBase.length > 0) lines.push(`- ${codeSpan(criterion.id)} at the base: ${atBase.join(', ')}`)
  }
  return lines
}

// Text shown on a pull request goes in a code span, where nothing renders: a
// link, raw HTML, a bare URL or an @mention in a reason or a path stays text.
// The fence is longer than any backtick run inside, so the text is shown
// exactly (a path can still be found in the artifact) and cannot end the span.
export function codeSpan(text: string): string {
  const flat = text.replaceAll('\r', ' ').replaceAll('\n', ' ')
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${flat}${pad}${fence}`
}

/** An artefact as a comment names it (#75): its path, and the start of the hash of the file that was installed. */
function artefactSpan(artefact: { path: string; source: 'prebuilt' | 'built'; sha256?: string }): string {
  const hash = artefact.sha256 === undefined ? '' : `, sha256 ${codeSpan(artefact.sha256.slice(0, 12))}`
  return `${codeSpan(artefact.path)} (${artefact.source === 'built' ? 'built by this run' : 'prebuilt'}${hash})`
}

/**
 * What became of an install once its checks were done (#75): removed, or,
 * when the teardown failed, why it is still there. The reason is run text,
 * so on a pull request it is a code span.
 */
function removalNote(artefact: { leftover?: string }, posted: boolean, log: string): string {
  if (artefact.leftover === undefined) return ' and removed afterwards.'
  return `. It was not removed afterwards (${posted ? codeSpan(artefact.leftover) : artefact.leftover}): ${codeSpan(log)} says what is left.`
}

/**
 * Whether the head's provisioning blocked the run (#75): every criterion is
 * unverified and points at the provisioning log, which is what a run writes
 * when a build never got as far as a check.
 */
function provisioningStopped(result: RunResult): boolean {
  return (
    result.criteria.length > 0 &&
    result.criteria.every((criterion) => criterion.outcome === 'unverified' && (criterion.evidence ?? []).some((path) => /(^|\/)provision\.log$/.test(path)))
  )
}

// In a table a pipe ends the cell even inside a code span unless escaped.
function cellSpan(text: string): string {
  return text === '' ? '' : codeSpan(text).replaceAll('|', '\\|')
}

function artifactLine(url: string | undefined): string {
  if (url === undefined) return "The run's evidence was not uploaded, so these files are named but not linked."
  return `The run's evidence is in its [evidence artifact](<${url}>), for as long as GitHub keeps it.`
}

function escapeLinkText(text: string): string {
  return text.replace(/[\[\]]/g, ' ')
}

/**
 * What a profile required of the host, in a sentence (#76). Whether the host
 * offers hardware virtualisation is said beside the requirement for it,
 * because nothing else in the comment names that fact.
 */
function requirementLines(requirements: Requirements, subject: string, host: HostKind | undefined): string[] {
  const named = describeRequirements(requirements)
  if (named.length === 0) return []
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
  const offers =
    requirements.virtualisation === true && host !== undefined ? `; this host offers ${host.virtualisation ? '' : 'no '}hardware virtualisation` : ''
  return [`${subject} requires ${list}${offers}.`]
}

/**
 * A profile name is repository content, so it is escaped before it becomes a
 * heading: a name that carries Markdown or HTML cannot reshape the comment or
 * inject markup into it (#55).
 */
function escapeHeading(text: string): string {
  return (
    text
      // A line break in the name ends the heading early and injects Markdown
      // below it, so it flattens to a space first.
      .replaceAll('\r', ' ')
      .replaceAll('\n', ' ')
      .replaceAll('\\', '\\\\')
      .replaceAll('`', '\\`')
      .replaceAll('|', '\\|')
      .replaceAll('<', '\\<')
      .replaceAll('>', '\\>')
      .replaceAll('[', '\\[')
      .replaceAll(']', '\\]')
      .replaceAll('*', '\\*')
      .replaceAll('_', '\\_')
      .replaceAll('~', '\\~')
  )
}

export function renderComment(result: RunResult, links: EvidenceLinks = { kind: 'relative' }): string {
  const posted = links.kind === 'artifact'
  const cell = posted ? cellSpan : escapeCell
  const baseRan = result.base?.status === 'executed'
  const table = (criteria: CriterionResult[]): string[] => [
    '| criterion | outcome | reason |',
    '| --- | --- | --- |',
    ...criteria.map(
      criterion =>
        `| ${cell(criterion.id)} | ${criterion.outcome}${criterion.regression === true ? ' (regression)' : ''}${criterion.cached === true ? ' (cached)' : ''} | ${cell(reasonCell(criterion, baseRan))} |`,
    ),
  ]
  // Two sides (#147): say which base the head was compared with, or that it
  // was not, so nobody reads a plain failure as one that was compared. The
  // reason quotes what stopped the base, so on a pull request it is a code
  // span like every other piece of run text.
  const baseLines =
    result.base === undefined
      ? []
      : result.base.status === 'executed'
        ? [`The plan ran on both sides: at the base ${codeSpan(result.base.ref)} and at the head. A criterion that passed at the base and fails at the head is a regression.`, '']
        : [
            `The base ${codeSpan(result.base.ref)} was not checked (${posted ? codeSpan(result.base.reason ?? '') : (result.base.reason ?? '')}), so nothing was compared with it and no regression was looked for.`,
            '',
          ]
  const job = result.job === undefined ? '' : ` (job ${posted ? codeSpan(result.job.id) : result.job.id})`
  const imageLines = (image: NonNullable<typeof result.environment>['image']): string[] =>
    image === undefined
      ? []
      : [
          `Produced by image ${codeSpan(image.ref)} at digest ${codeSpan(image.digest)}${image.flavour === undefined ? '' : ` (flavour ${image.flavour})`}.`,
          ...(image.drivers === undefined
            ? []
            : [`Drivers it ships: ${Object.entries(image.drivers).map(([name, version]) => `${name} ${version}`).join(', ')}.`]),
        ]
  // The host kind that produced the result (#76), when the run recorded it:
  // a verdict from a hosted Linux runner and one from somebody's own macOS
  // machine are not the same claim, and a reader is told which this is.
  const host = result.environment?.host
  const where =
    host === undefined
      ? result.environment?.execution === 'native'
        ? 'natively on a host'
        : 'in a container'
      : `${result.environment?.execution === 'native' ? 'natively' : 'in a container'} on ${describeHost(host)}${host.runner === undefined ? '' : ','}`
  const environment = result.environment === undefined
    ? []
    : [
        `Executed ${where} with qare ${result.environment.versions.qare}, node ${result.environment.versions.node}, nare contract ${result.environment.versions.nareContract}.`,
        ...(result.environment.image === undefined ? [] : imageLines(result.environment.image)),
        // What the profile required of that host (#76), met or not.
        ...(result.requirements === undefined ? [] : requirementLines(result.requirements, 'The profile', host)),
        '',
      ]
  const lines = [
    `## QARE run: ${result.verdict}${job}`,
    '',
    // One side only: say so, so nobody reads the table as base against head.
    // The URL stays a code span; a comment links only to uploaded files.
    ...(result.target === undefined
      ? []
      : [`Checked against the running target ${codeSpan(result.target.url)}. Nothing ran at a base revision, so there is no base comparison and no regression was looked for.`, '']),
    // A build the run launched has one side too (#72): the driver and the
    // executable are named, so a reader knows what the checks drove.
    // A build the run provisioned (#75) names the artefact it installed for
    // each side: which file the checks drove is a fact a reader can check,
    // and which revision a prebuilt file was built from is not qare's to say.
    ...(result.client === undefined
      ? []
      : result.client.artefact === undefined
        ? [`Checked against the ${result.client.driver} build ${codeSpan(result.client.executable)}, launched by the run. Nothing ran at a base revision, so there is no base comparison and no regression was looked for.${clientEgressNote(result.client.egress)}`, '']
        : provisioningStopped(result)
          ? [
              // Nothing was installed, so nothing was checked against it.
              `The ${result.client.driver} build ${codeSpan(result.client.executable)} was to be installed from ${artefactSpan(result.client.artefact)}, and provisioning stopped before any check ran: the log is listed with each criterion.`,
              '',
            ]
          : [
            `Checked against the ${result.client.driver} build ${codeSpan(result.client.executable)}, installed by the run from ${artefactSpan(result.client.artefact)}${removalNote(result.client.artefact, posted, result.base === undefined ? 'provision.log' : 'head/provision.log')}${
              result.base === undefined ? ' Nothing ran at a base revision, so there is no base comparison and no regression was looked for.' : ''
            }${
              result.client.base === undefined
                ? ''
                : ` The base side is the build installed from ${artefactSpan(result.client.base)}: the pipeline that produced that file vouches for the revision it was built from${
                    result.client.base.leftover === undefined ? '.' : removalNote(result.client.base, posted, 'base/provision.log')
                  }`
            }${clientEgressNote(result.client.egress)}`,
            '',
          ]),
    ...baseLines,
    // Where the run executed and what it ran with (issue #91): a host run and
    // an image run are readable side by side.
    ...environment,
    // Several apps in one run (#55): one section per app, each with the
    // verdict it earned, because one app failing says nothing about another.
    ...(result.profiles === undefined
      ? table(result.criteria)
      : [
          `This run checked ${result.profiles.length} apps, each under a profile of its own; each verdict is that app's alone.`,
          '',
          ...result.profiles.flatMap(summary => [
            `### ${escapeHeading(summary.name)} — verdict ${summary.verdict}`,
            '',
            // What this app's own profile required of the host (#76).
            ...(summary.requirements === undefined ? [] : requirementLines(summary.requirements, codeSpan(summary.name), host).flatMap((line) => [line, ''])),
            ...table(result.criteria.filter(criterion => summary.criteria.includes(criterion.id))),
            '',
          ]),
        ]),
  ]
  // The repairs the run recorded (#83), named in the comment of the run they
  // happened in: what the reference was, what it became (or why a repair was
  // refused to review), and the identity comparison that decided it.
  const repairs = result.criteria.flatMap((criterion) =>
    (criterion.repairs ?? []).map((repair) => ({ criterion: criterion.id, ...repair })),
  )
  if (repairs.length > 0) {
    lines.push(
      '',
      '## Locator repairs',
      '',
      'Locator repairs: an element reference that went stale was re-pointed only when the identity rule held (same role, same accessible name, same landmark ancestry), and an assertion was never repaired.',
      '',
      '| criterion | check | action | reference | repaired | identity | status |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...repairs.map((repair) =>
        `| ${cell(repair.criterion)} | ${cell(repair.check)} | ${repair.action} | ${cell(repair.reference)} | ${cell(repair.repaired ?? repair.refusedReason ?? '')} | ${cell(repair.identity)} | ${repair.status} |`,
      ),
    )
  }
  // What the accessibility audits found (#149), by criterion. A violation
  // the base already had does not fail anything, so the verdict table says
  // nothing about it: this is where old debt is reported. The counts are the
  // harness's own; each violation is named in the criterion's a11y.json.
  const audited = result.criteria.filter((criterion) => criterion.a11y !== undefined && Object.values(criterion.a11y).some((count) => count > 0))
  if (audited.length > 0) {
    lines.push(
      '',
      '## Accessibility',
      '',
      'Accessibility violations the audits found, counted by criterion. Only violations new at the head fail a criterion. Existing ones were already there at the base, accepted ones are carried by the profile with a reason, reported ones sit below the impacts that fail, and ones not compared had no base audit to be held against. Each is named, with its rule and element, in the `a11y.json` of the criterion.',
      '',
      '| criterion | new | existing | accepted | reported | not compared |',
      '| --- | --- | --- | --- | --- | --- |',
      ...audited.map((criterion) => {
        const counts = criterion.a11y!
        return `| ${cell(criterion.id)} | ${counts.new} | ${counts.existing} | ${counts.accepted} | ${counts.reported} | ${counts.uncompared} |`
      }),
    )
  }
  // The message that proved a criterion (#65), as the harness read it. Every
  // cell is the app's own text, so on a pull request it is a code span: a
  // link in it is named, never written as one, because a comment links only
  // to files that were uploaded.
  const messages = result.criteria.flatMap((criterion) => (criterion.mail ?? []).map((message) => ({ criterion: criterion.id, ...message })))
  if (messages.length > 0) {
    lines.push(
      '',
      '## Mail',
      '',
      'The message each mail check read, as the harness read it from the mail source: the sender, the subject, an excerpt and the links in it. Addresses and one-time codes are redacted, and the links are what the harness extracted, not what a model claimed.',
      '',
      '| criterion | check | sender | subject | excerpt | links |',
      '| --- | --- | --- | --- | --- | --- |',
      ...messages.map(
        (message) =>
          `| ${cell(message.criterion)} | ${cell(message.check)} | ${cell(message.from)} | ${cell(message.subject)} | ${cell(message.excerpt)} | ${message.links.map((link) => cell(link)).join(' ')} |`,
      ),
    )
  }
  // What the UX reviewer reported (#150): advisory, in a section that says so.
  if (result.advisory !== undefined) lines.push(...renderAdvisorySection(result.advisory, links))
  if (links.kind === 'relative') {
    const details = detailLinks(result.criteria)
    if (details.length > 0) lines.push('', 'Details:', '', ...details)
  } else {
    const details = detailNames(result.criteria, links.screenshots)
    if (details.length > 0) lines.push('', 'Details:', '', ...details)
    // The artifact holds result.json and the logs even when no criterion
    // lists a file, so it is linked whenever it was uploaded.
    if (details.length > 0 || links.url !== undefined) lines.push('', artifactLine(links.url))
  }
  const unverified = result.criteria.filter(criterion => criterion.outcome === 'unverified')
  const causes = new Set(unverified.map(unverifiedCause))
  if (causes.has('quarantine'))
    lines.push(
      '',
      'Quarantined checks failed and passed across the attempts this run gave them, so they decided nothing: their criteria are unverified, and the checks are skipped, with the reason and date they were quarantined, until someone removes them from the quarantine.',
    )
  if (causes.has('waived'))
    lines.push(
      '',
      'Waived criteria are recorded as waived (human) — a waiver is not a pass and needs out-of-band confirmation.',
    )
  if (causes.has('verifier'))
    lines.push(
      '',
      'Criteria not independently checked passed their checks, but the verifier could not review them, so they do not count as proven.',
    )
  if (causes.has('environment'))
    lines.push('', 'Unverified criteria could not verify (environment) — that is not a code defect.')
  return lines.join('\n')
}

export function renderCheckRun(result: RunResult): CheckRunPayload {
  const counts = { proven: 0, failed: 0, unverified: 0 }
  for (const criterion of result.criteria) counts[criterion.outcome] += 1
  // Regressions are named apart from the failures they are among (#147).
  const regressions = result.criteria.filter((criterion) => criterion.regression === true).length
  const regressed = regressions === 0 ? '' : `; ${regressions} regression${regressions === 1 ? '' : 's'} against the base`
  return {
    title: 'QARE',
    summary: `verdict ${result.verdict}: ${counts.proven} proven, ${counts.failed} failed, ${counts.unverified} unverified${regressed}`,
    conclusion: CHECK_RUN_CONCLUSIONS[result.verdict],
  }
}

/** What a client run's comment says about the build's network (#223): contained, opted out, or (an older result) nothing. */
function clientEgressNote(egress: 'contained' | 'uncontained' | undefined): string {
  if (egress === 'contained') return " The build ran contained, with no network of its own: the hosts it reached through the gate are in each flow check's `outbound.json`."
  if (egress === 'uncontained')
    return ' The build was not contained (`client.egress: uncontained`): it ran with the network its step had, and what it reached was not recorded.'
  return ''
}
