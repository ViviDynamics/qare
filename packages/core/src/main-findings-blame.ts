import { codeSpan } from './evidence.js'
import type { MainFinding } from './main-findings.js'

/**
 * Who a finding on `main` names (#154), decided in code from the pull
 * requests merged since the ledger's last pass (rule 3). The judge-side step
 * asks GitHub for the range; nothing here touches the network.
 */

/** A GitHub account as blame reads it: its login, and whether GitHub says it is a bot. */
export interface RangePerson {
  login: string
  bot: boolean
}

/** A pull request merged since the criterion last passed. */
export interface RangePull {
  number: number
  title: string
  /** Who opened it; absent when the account is gone. */
  author?: RangePerson
  mergedBy?: RangePerson
  /** Who approved it, in the order they did. */
  approvers: RangePerson[]
  /** The paths it changed. */
  files: string[]
}

/** The commits on the checked revision since the criterion last passed, and the pull requests that brought them. */
export interface BlameRange {
  /** The revision the failing run checked. */
  head: string
  commits: Array<{ sha: string; subject: string }>
  /** More commits or pull requests are in the range than were read. */
  truncated: boolean
  pulls: RangePull[]
}

/** Who a pull request of the range names, and in what role. */
export interface BlamedPerson {
  pull: number
  /** The person mentioned for it; absent when no person could be found. */
  login?: string
  role: 'author' | 'merged' | 'approved' | 'nobody'
  /** The bot that opened it, when one did: why its author is not the one named. */
  bot?: string
}

export interface Blame {
  /** The logins and teams written as mentions on a new issue, without the at sign. */
  mentions: string[]
  people: BlamedPerson[]
  /** People of the range left unmentioned by the cap. */
  unmentioned: number
  /** The pull request the evidence points at most, and why. */
  pointed?: { pull: number; why: string }
  /** Why no pull request is singled out, when several are in the range. */
  unpointed?: string
  /** Set when no change could be blamed: who is mentioned in an author's place, if the profile names one, and why. */
  fallback?: { login?: string; why: string }
}

/** The findings section of a profile, as blame reads it. */
export interface BlameConfig {
  fallback?: string
  bots?: string[]
}

/** The most people one issue mentions. A long gap between sweeps must not notify a whole team's worth of authors. */
export const MAX_MENTIONS = 10

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const TEAM = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/** What follows an at sign on a published issue is a login, or a team, and nothing else. */
export function isMentionable(name: string): boolean {
  return LOGIN.test(name) || TEAM.test(name)
}

/** Whether an account is a bot: GitHub says so, its login does, or the profile lists it. */
export function isBotAccount(person: RangePerson, config: BlameConfig | undefined): boolean {
  if (person.bot || person.login.endsWith('[bot]')) return true
  const named = person.login.toLowerCase()
  return (config?.bots ?? []).some((bot) => bot.toLowerCase() === named)
}

function human(person: RangePerson | undefined, config: BlameConfig | undefined): string | undefined {
  if (person === undefined || isBotAccount(person, config) || !LOGIN.test(person.login)) return undefined
  return person.login
}

/**
 * Who a pull request names: its author, or, when a bot or an orchestrator
 * opened it, the person who merged it, else the first person who approved
 * it. A bot account cannot act on a notification, so it is never the one.
 */
function personOf(pull: RangePull, config: BlameConfig | undefined): BlamedPerson {
  const author = human(pull.author, config)
  if (author !== undefined) return { pull: pull.number, login: author, role: 'author' }
  const bot = pull.author !== undefined && isBotAccount(pull.author, config) ? { bot: pull.author.login } : {}
  const merger = human(pull.mergedBy, config)
  if (merger !== undefined) return { pull: pull.number, login: merger, role: 'merged', ...bot }
  for (const approver of pull.approvers) {
    const login = human(approver, config)
    if (login !== undefined) return { pull: pull.number, login, role: 'approved', ...bot }
  }
  return { pull: pull.number, role: 'nobody', ...bot }
}

/** The repository paths a criterion's check references name; a suite names none. */
function checkPaths(checks: string[]): string[] {
  const paths: string[] = []
  for (const check of checks) {
    if (check.startsWith('suite:')) continue
    const at = check.indexOf(':')
    const path = at === -1 ? check : check.slice(0, at)
    if (path !== '') paths.push(path)
  }
  return paths
}

/** A changed file is covered by a check path when one sits at or under the other, at a segment boundary. */
function covers(path: string, file: string): boolean {
  return file === path || file.startsWith(`${path}/`) || path.startsWith(`${file}/`)
}

function joinPulls(numbers: number[]): string {
  const named = [...numbers].sort((a, b) => a - b).map((number) => `#${number}`)
  return named.length <= 1 ? named.join('') : `${named.slice(0, -1).join(', ')} and ${named.at(-1) ?? ''}`
}

function pointedAt(finding: MainFinding, pulls: RangePull[]): Pick<Blame, 'pointed' | 'unpointed'> {
  const only = pulls[0]
  if (pulls.length === 1 && only !== undefined)
    return { pointed: { pull: only.number, why: 'it is the only pull request merged since the criterion last passed' } }
  const paths = checkPaths(finding.checks)
  if (paths.length === 0)
    return { unpointed: "the criterion's checks name no repository path, so the files a pull request changed cannot tell them apart" }
  const touched = pulls
    .map((pull) => ({ pull: pull.number, files: pull.files.filter((file) => paths.some((path) => covers(path, file))) }))
    .sort((a, b) => b.files.length - a.files.length)
  const top = touched[0]
  if (top === undefined || top.files.length === 0)
    return { unpointed: `none of them touched the files the failing checks cover (${paths.map(codeSpan).join(', ')})` }
  const level = touched.filter((entry) => entry.files.length === top.files.length)
  if (level.length > 1)
    return { unpointed: `${joinPulls(level.map((entry) => entry.pull))} each touched ${top.files.length} file(s) the failing checks cover, so the files cannot tell them apart` }
  const named = top.files.slice(0, 3).map(codeSpan).join(', ')
  const more = top.files.length > 3 ? ` and ${top.files.length - 3} more` : ''
  return { pointed: { pull: top.pull, why: `it touched ${top.files.length} file(s) the failing checks cover (${named}${more}), more than any other pull request in the range` } }
}

function fallbackTo(config: BlameConfig | undefined, why: string): Blame {
  const login = config?.fallback !== undefined && isMentionable(config.fallback) ? config.fallback : undefined
  return {
    mentions: login === undefined ? [] : [login],
    people: [],
    unmentioned: 0,
    fallback: { ...(login === undefined ? {} : { login }), why },
  }
}

/**
 * Who a finding names. With a recorded pass and pull requests merged since,
 * each one's person is mentioned once, and the pull request whose changed
 * files overlap the failing checks most is the one the evidence points at.
 * With nothing to blame (no recorded pass, no pull request, nobody but bots)
 * the profile's fallback is mentioned in an author's place, with the reason.
 */
export function blameMainFinding(finding: MainFinding, range: BlameRange | undefined, config: BlameConfig | undefined): Blame {
  const proven = finding.lastProven
  if (proven !== undefined && range === undefined)
    return fallbackTo(config, 'the ledger dates its last pass in a way that cannot be read, so there is no range of commits to read')
  if (proven === undefined || range === undefined)
    return fallbackTo(
      config,
      finding.kind === 'regression'
        ? "the ledger has no record of this criterion's last pass, so there is no range of commits to read"
        : 'the ledger has no record of this criterion ever passing, so there is no change to blame',
    )
  // The run id and the timestamp are the ledger's own text: in code spans, where nothing in them renders.
  const since = `the criterion last passed (run ${codeSpan(proven.run)}, ${codeSpan(proven.at)})`
  if (range.commits.length === 0) return fallbackTo(config, `no commit landed on the checked revision since ${since}`)
  if (range.pulls.length === 0)
    return fallbackTo(config, `no pull request brought the ${range.commits.length} commit(s) that landed since ${since}`)
  const people = range.pulls.map((pull) => personOf(pull, config))
  const logins = [...new Set(people.flatMap((person) => (person.login === undefined ? [] : [person.login])))]
  if (logins.length === 0)
    return { ...fallbackTo(config, `no person opened, merged or approved the pull request(s) merged since ${since}`), people }
  return {
    mentions: logins.slice(0, MAX_MENTIONS),
    people,
    unmentioned: Math.max(0, logins.length - MAX_MENTIONS),
    ...pointedAt(finding, range.pulls),
  }
}

/** An environment that is down has no author: the fallback is who hears of it. */
export function blameEnvironment(config: BlameConfig | undefined): Blame {
  return fallbackTo(config, 'an environment that is down is no change of anyone, so there is no author to name')
}
