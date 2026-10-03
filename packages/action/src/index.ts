import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { FileLedgerStore, loadProfile, loadResult, redactionRules, RUN_VERDICTS, valueRules, VERSION } from '@qare/core'
import { GitHubClient, GitHubClientError } from './github.js'
import { GitHubQaAssetsPusher } from './qa-assets.js'
import { fileRefusalStubs, GitHubStubIssuePoster } from './stub-issues.js'
import { requeueUnblocked, stubDiffArgs, stubKeysFromDiffText } from './requeue.js'
import { GitHubEvidencePoster, postEvidence } from './post-evidence.js'
import { deliverIngest, IngestDeliveryError } from './ingest-deliver.js'
import { loadQuestions, postQuestions } from './post-questions.js'
import { parseSweepPayload, publishSweep } from './sweep-report.js'
import { reportPipelineFailure } from './report-failure.js'
import { carryOutAdvisoryReplies } from './advisory-replies.js'
import { MAX_NEW_ISSUES, publishMainFindings, type MainFindingAction } from './main-findings.js'
// The GitHub client and the stub issue poster, for `qare init --file-issues`
// (#146): the CLI files a stub issue the way the pipeline does.
export { GitHubClient, GitHubClientError } from './github.js'
// Who qare posts as (#61): the interface, its three implementations, and the
// resolution that picks one from what the install configured.
export {
  ACTIONS_LOGIN,
  ACTIONS_TOKEN_ENV,
  APP_ID_ENV,
  APP_PRIVATE_KEY_ENV,
  PERSONAL_TOKEN_ENV,
  ActionsTokenIdentity,
  AppInstallationIdentity,
  TokenIdentity,
  resolveIdentity,
} from './identity.js'
export type { GitHubIdentity, IdentityOptions } from './identity.js'
export { GitHubStubIssuePoster } from './stub-issues.js'

export interface Writer {
  write(chunk: string): void
}

const execFileAsync = promisify(execFile)

export function entry(out: Writer = process.stdout): void {
  out.write(`@qare/action ${VERSION}\n`)
}

export async function main(argv: string[], out: Writer = process.stdout, err: Writer = process.stderr): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (command === 'stub-issues') return await stubIssuesCommand(rest, out)
    if (command === 'requeue') return await requeueCommand(rest, out)
    if (command === 'post-evidence') return await postEvidenceCommand(rest, out)
    if (command === 'ingest-deliver') return await ingestDeliverCommand(rest, out)
    if (command === 'post-questions') return await postQuestionsCommand(rest, out)
    if (command === 'sweep-report') return await sweepReportCommand(rest, out)
    if (command === 'report-failure') return await reportFailureCommand(rest, out)
    if (command === 'advisory-replies') return await advisoryRepliesCommand(rest, out)
    if (command === 'main-findings') return await mainFindingsCommand(rest, out)
  } catch (error) {
    err.write(error instanceof Error ? `${error.name}: ${error.message}\n` : `${String(error)}\n`)
    return 1
  }
  entry(out)
  if (command !== undefined) {
    err.write(`unknown command ${JSON.stringify(command)}: qare-action understands "stub-issues", "requeue", "post-evidence", "ingest-deliver", "post-questions", "sweep-report", "report-failure", "advisory-replies" and "main-findings"\n`)
    return 1
  }
  return 0
}

function stubIssuesCommand(argv: string[], out: Writer): Promise<number> {
  const flags = parseFlags(argv)
  return runStubIssues({
    resultPath: flags.string('result'),
    pr: flags.number('pr'),
    repository: flags.string('repository'),
    apiRoot: flags.string('api-root'),
    tokenEnv: flags.string('token-env'),
  }).then((filed) => {
    if (filed === undefined) {
      out.write('verdict is not refused: no stub issues to file\n')
      return 0
    }
    for (const item of filed) out.write(`filed stub issue #${item.issue} for ${item.key}\n`)
    return 0
  })
}

async function runStubIssues(
  opts: { resultPath: string | undefined; pr: number | undefined; repository?: string | undefined; apiRoot?: string | undefined; tokenEnv?: string | undefined },
): Promise<Array<{ key: string; issue: number }> | undefined> {
  if (opts.resultPath === undefined || opts.resultPath === '') {
    throw new GitHubClientError('qare-action stub-issues needs --result <path to result.json>')
  }
  if (opts.pr === undefined || !Number.isInteger(opts.pr) || opts.pr <= 0) {
    throw new GitHubClientError('qare-action stub-issues needs --pr <pull request number>')
  }
  const text = await readFile(opts.resultPath, 'utf8')
  const result = loadResult(text)
  if (result.verdict !== 'refused') return undefined
  const client = new GitHubClient({ repository: opts.repository, apiRoot: opts.apiRoot, tokenEnv: opts.tokenEnv })
  return fileRefusalStubs(new GitHubStubIssuePoster(client), result, opts.pr)
}

/**
 * `ingest-deliver`: carry an ingest payload to GitHub (#37). The proposal
 * becomes a pull request against the base branch for a human to apply, and
 * every uncheckable criterion gets its one comment, never repeated. A payload
 * built on a ledger that has since moved is refused here, so the proposal can
 * not silently drop a rule that moved in between.
 */
async function ingestDeliverCommand(argv: string[], out: Writer): Promise<number> {
  const flags = parseFlags(argv)
  const proposalPath = flags.string('proposal')
  const base = flags.string('base')
  if (proposalPath === undefined) throw new IngestDeliveryError('qare-action ingest-deliver needs --proposal <path to ingest-proposal.json>')
  if (base === undefined) throw new IngestDeliveryError('qare-action ingest-deliver needs --base <branch the pull request targets>')
  const delivery = await deliverIngest({
    proposalPath,
    ...(flags.string('comments') === undefined ? {} : { commentsPath: flags.string('comments') }),
    base,
    client: new GitHubClient({
      repository: flags.string('repository'),
      apiRoot: flags.string('api-root'),
      tokenEnv: flags.string('token-env'),
    }),
  })
  out.write(
    delivery.alreadyProposed
      ? 'proposal already open as a pull request; nothing new to open\n'
      : `opened pull request #${delivery.pull.number} against ${base}${delivery.pull.htmlUrl === undefined ? '' : `: ${delivery.pull.htmlUrl}`}\n`,
  )
  for (const issue of delivery.postedComments) out.write(`commented once on #${issue}\n`)
  for (const issue of delivery.skippedComments) out.write(`#${issue} already carries the comment; left alone\n`)
  return 0
}

async function postEvidenceCommand(argv: string[], out: Writer): Promise<number> {
  const flags = parseFlags(argv)
  const resultPath = flags.string('result')
  const pr = flags.number('pr')
  const headSha = flags.string('sha')
  if (resultPath === undefined || resultPath === '')
    throw new GitHubClientError('qare-action post-evidence needs --result <path to judged-result.json>')
  if (pr === undefined) throw new GitHubClientError('qare-action post-evidence needs --pr <pull request number>')
  if (headSha === undefined) throw new GitHubClientError('qare-action post-evidence needs --sha <head commit>')
  // An empty value is what a workflow expression gives when no artifact was
  // uploaded; it means no link, never a link to nothing.
  const artifactUrl = flags.string('artifact-url') || undefined
  if (artifactUrl !== undefined && !/^https:\/\/[^\s<>]+$/.test(artifactUrl))
    throw new GitHubClientError(`--artifact-url must be an https URL (got ${JSON.stringify(artifactUrl)})`)
  const result = loadResult(await readFile(resultPath, 'utf8'))
  const client = new GitHubClient({
    repository: flags.string('repository'),
    apiRoot: flags.string('api-root'),
    tokenEnv: flags.string('token-env'),
  })
  // The sticky comment is found by its author, so the author is whoever this
  // run posts as (#61): the App's bot, the token's user, or the Actions bot.
  const author = flags.string('author') || (await client.identity.login())
  // Screenshots are pushed to qa-assets only when the evidence directory the
  // judge downloaded is named; without it the comment links to the artifact
  // alone, which is still where everything else lives.
  const evidenceDir = flags.string('evidence') || undefined
  const push =
    evidenceDir === undefined ? undefined : new GitHubQaAssetsPusher(client, headSha, { branch: flags.string('branch') })
  // The run's metrics record (#51) rides to the qa-assets branch when its file
  // is named, whether or not there were screenshots to push. It is data the
  // pilot reads later, so a store it could not reach is named and left
  // behind, never fatal: metrics describe runs, they do not gate them.
  const metricsPath = flags.string('metrics') || undefined
  if (metricsPath !== undefined) {
    try {
      const record: unknown = JSON.parse(await readFile(metricsPath, 'utf8'))
      await new GitHubQaAssetsPusher(client, headSha, { branch: flags.string('branch') }).pushMetrics(record)
      out.write(`pushed the run's metrics record to ${flags.string('branch') ?? 'qa-assets'}\n`)
    } catch (error) {
      out.write(`metrics record not pushed (${error instanceof Error ? error.message : String(error)}); the verdict does not depend on it\n`)
    }
  }
  // The conflicts the pull request itself introduces are asked in this very
  // comment, where its author is already notified (#41). The questions file
  // is optional: a run with nothing open renders exactly as it did before.
  const questionsPath = flags.string('questions') || undefined
  const questions = questionsPath === undefined ? [] : loadQuestions(await readFile(questionsPath, 'utf8'))
  const riding = questions.filter((question) => question.source.kind === 'pull-request')
  await postEvidence(new GitHubEvidencePoster(client, pr, headSha, author), result, {
    artifactUrl,
    push,
    evidenceDir,
    questions: riding,
  })
  out.write(`posted verdict ${result.verdict} on pull request #${pr} at ${headSha.slice(0, 12)}\n`)
  if (riding.length > 0) out.write(`asked ${riding.length} question(s) in the evidence comment\n`)
  return 0
}

/**
 * `qare-action report-failure`: the pipeline failed and published no verdict
 * (#203). Read the run's jobs, and when one failed, post on the pull request
 * that no criterion was evaluated, naming the job and step, so a failure in
 * qare or its runner is never read as the project failing its criteria.
 */
async function reportFailureCommand(argv: string[], out: Writer): Promise<number> {
  const flags = parseFlags(argv)
  const runId = flags.number('run-id')
  const pr = flags.number('pr')
  const headSha = flags.string('sha')
  if (runId === undefined || runId <= 0) throw new GitHubClientError('qare-action report-failure needs --run-id <workflow run id>')
  if (pr === undefined) throw new GitHubClientError('qare-action report-failure needs --pr <pull request number>')
  if (headSha === undefined) throw new GitHubClientError('qare-action report-failure needs --sha <head commit>')
  const attempt = flags.number('attempt') ?? 1
  if (attempt <= 0) throw new GitHubClientError(`--attempt must be a positive integer (got ${attempt})`)
  const runUrl = flags.string('run-url') || undefined
  if (runUrl !== undefined && !/^https:\/\/[^\s<>`]+$/.test(runUrl))
    throw new GitHubClientError(`--run-url must be an https URL (got ${JSON.stringify(runUrl)})`)
  // Execute's verdict output, passed as is: empty when it recorded none.
  const recordedVerdict = flags.string('recorded-verdict') || undefined
  if (recordedVerdict !== undefined && !(RUN_VERDICTS as readonly string[]).includes(recordedVerdict))
    throw new GitHubClientError(
      `--recorded-verdict must be a run verdict (${RUN_VERDICTS.join(', ')}) or empty (got ${JSON.stringify(recordedVerdict)})`,
    )
  const client = new GitHubClient({
    repository: flags.string('repository'),
    apiRoot: flags.string('api-root'),
    tokenEnv: flags.string('token-env'),
  })
  const author = flags.string('author') || (await client.identity.login())
  const poster = new GitHubEvidencePoster(client, pr, headSha, author)
  const outcome = await reportPipelineFailure(client, poster, {
    id: runId,
    attempt,
    pr,
    headSha,
    author,
    url: runUrl,
    recordedVerdict,
    // The workflow's pipeline job ids: jobs outside them (one gated on push,
    // the report job itself) are neither the failure nor skipped by it.
    pipeline: flags.list('pipeline'),
    // The id of the job asking, which is still running: the calling job it
    // is listed under is the one whose jobs are this pipeline's (#145).
    reporter: flags.string('reporter'),
  })
  if (outcome.kind === 'nothing-failed') {
    out.write(`no job in run ${runId} failed: nothing to report\n`)
    return 0
  }
  if (outcome.kind === 'verdict-kept') {
    out.write(`a verdict for ${headSha.slice(0, 12)} is already on pull request #${pr}; left it in place\n`)
    return 0
  }
  const { failure } = outcome
  const where = failure.step === undefined ? failure.job : `${failure.job} failing at ${failure.step}`
  const side = recordedVerdict === undefined ? 'not evaluated' : `verdict ${recordedVerdict} not published`
  out.write(`reported ${where} on pull request #${pr} at ${headSha.slice(0, 12)}: ${side}, qare or environment failure\n`)
  return 0
}

/**
 * `qare-action advisory-replies`: carry out the replies people made to the
 * advisory findings on a pull request (#150). `/qa-dismiss <id>` is recorded,
 * `/qa-promote <id>` files the finding as an issue, each once. `--out` writes
 * the findings that stand dismissed, which judge hands the reviewer of the
 * next run so they are not raised again.
 */
async function advisoryRepliesCommand(argv: string[], out: Writer): Promise<number> {
  const flags = parseFlags(argv)
  const pr = flags.number('pr')
  if (pr === undefined || pr <= 0) throw new GitHubClientError('qare-action advisory-replies needs --pr <pull request number>')
  const client = new GitHubClient({
    repository: flags.string('repository'),
    apiRoot: flags.string('api-root'),
    tokenEnv: flags.string('token-env'),
  })
  // Findings and records are read from this identity's own comments, as the
  // sticky evidence comment is found (#61).
  const author = flags.string('author') || (await client.identity.login())
  const replies = await carryOutAdvisoryReplies(client, pr, author)
  const outPath = flags.string('out')
  if (outPath !== undefined && outPath !== '')
    await writeFile(outPath, `${JSON.stringify({ dismissed: replies.dismissed }, null, 2)}\n`, 'utf8')
  out.write(`carried out ${replies.answered} advisory reply(ies) on pull request #${pr}: ${replies.dismissed.length} dismissed finding(s) stand\n`)
  for (const entry of replies.promoted) out.write(`filed advisory finding ${entry.id} as #${entry.issue}\n`)
  return 0
}

/**
 * `qare-action main-findings`: file what a run on `main` found (#154). A run
 * there has no pull request to comment on, so a failed criterion becomes an
 * issue, found again by its marker: opened once, commented on while it still
 * fails, reopened when a person closed it too early, closed when a run
 * proves the criterion again. A run in which nothing booted is one issue.
 *
 * This is a judge-side step: it holds the GitHub identity (#61) and runs
 * nothing from the repository (rule 7). The result, the ledger and the
 * profile are read as data. `--dry-run true` reads and writes nothing, and
 * prints what a real run would do and whom it would mention.
 */
async function mainFindingsCommand(argv: string[], out: Writer): Promise<number> {
  const flags = parseFlags(argv)
  const resultPath = flags.string('result')
  const ledgerDir = flags.string('ledger')
  const headSha = flags.string('sha')
  if (resultPath === undefined || resultPath === '')
    throw new GitHubClientError('qare-action main-findings needs --result <path to judged-result.json>')
  if (ledgerDir === undefined || ledgerDir === '') throw new GitHubClientError('qare-action main-findings needs --ledger <the ledger directory>')
  if (headSha === undefined || !/^[0-9a-f]{40}$/.test(headSha))
    throw new GitHubClientError(`--sha must be the 40 character commit the run checked (got ${JSON.stringify(headSha ?? '')})`)
  // An empty value is what a workflow expression gives when there is none.
  const link = (name: string): string | undefined => {
    const url = flags.string(name) || undefined
    if (url !== undefined && !/^https:\/\/[^\s<>`]+$/.test(url)) throw new GitHubClientError(`--${name} must be an https URL (got ${JSON.stringify(url)})`)
    return url
  }
  const runUrl = link('run-url')
  const artifactUrl = link('artifact-url')
  const dryRun = flags.string('dry-run') === 'true'
  const result = loadResult(await readFile(resultPath, 'utf8'))
  const ledger = await new FileLedgerStore(resolve(ledgerDir)).loadDocument()
  // The profile names the fallback and the bots, and what must not be published.
  const profileDir = flags.string('profile') || undefined
  const profile = profileDir === undefined ? undefined : await loadProfile(resolve(profileDir))
  const login = profile?.app?.login
  const rules = [...redactionRules(profile?.redact), ...valueRules([login?.totp?.secret, login?.backupCode?.value])]
  const client = new GitHubClient({
    repository: flags.string('repository'),
    apiRoot: flags.string('api-root'),
    tokenEnv: flags.string('token-env'),
  })
  const author = flags.string('author') || (await client.identity.login())
  const evidenceDir = flags.string('evidence') || undefined
  const outcome = await publishMainFindings(client, {
    result,
    ledger,
    headSha,
    author,
    findings: profile?.findings,
    rules,
    runUrl,
    artifactUrl,
    push: evidenceDir === undefined ? undefined : new GitHubQaAssetsPusher(client, headSha, { branch: flags.string('branch') }),
    evidenceDir,
    dryRun,
  })
  if (dryRun) out.write('dry run: nothing is written\n')
  if (outcome.actions.length === 0) out.write('no finding on main to file, update or close\n')
  for (const action of outcome.actions) out.write(`${describeMainFindingAction(action, dryRun)}\n`)
  for (const criterion of outcome.flaky) out.write(`${criterion} is held by a quarantined check: nothing is filed for a flake\n`)
  return 0
}

function describeMainFindingAction(action: MainFindingAction, dryRun: boolean): string {
  const about = action.criterion ?? 'the environment'
  if (action.action === 'opened') {
    const label = action.kind === 'environment' ? 'qa-environment' : action.kind === 'regression' ? 'qa-regression' : 'qa-failure'
    const who = action.mentions.length === 0 ? 'mentioning nobody' : `mentioning ${action.mentions.join(', ')}`
    return dryRun || action.issue === undefined
      ? `would open an issue for ${about} (${label}), ${who}`
      : `opened #${action.issue} for ${about} (${label}), ${who}`
  }
  if (action.action === 'deferred') return `left ${about} for the next run: this run opened its ${MAX_NEW_ISSUES} issues`
  const still = action.criterion === undefined ? 'still down' : 'still failing'
  if (action.action === 'updated') return `${dryRun ? 'would comment' : 'commented'} on #${action.issue} for ${about}: ${still}`
  if (action.action === 'reopened') return `${dryRun ? 'would reopen' : 'reopened'} #${action.issue} for ${about}: closed while ${still}`
  return `${dryRun ? 'would close' : 'closed'} #${action.issue} for ${about}: ${action.criterion === undefined ? 'a check executed again' : 'proven again'}`
}

/**
 * `qare-action post-questions`: ask the questions a resolution report holds
 * in their places (#41) — on the linked issue mentioning its author, on a
 * sweep finding's issue mentioning the person the finding blames — each once,
 * by marker. Questions a pull request introduces ride the evidence comment
 * and are only counted here.
 */
async function postQuestionsCommand(argv: string[], out: Writer): Promise<number> {
  const flags = parseFlags(argv)
  const questionsPath = flags.string('questions')
  if (questionsPath === undefined || questionsPath === '')
    throw new GitHubClientError('qare-action post-questions needs --questions <path to resolution.json>')
  const questions = loadQuestions(await readFile(questionsPath, 'utf8'))
  const client = new GitHubClient({
    repository: flags.string('repository'),
    apiRoot: flags.string('api-root'),
    tokenEnv: flags.string('token-env'),
  })
  const author = flags.string('author') || (await client.identity.login())
  const posting = await postQuestions(client, questions, author)
  for (const { issue } of posting.posted) out.write(`asked once on #${issue}\n`)
  for (const { issue } of posting.skipped) out.write(`#${issue} already carries the question; left alone\n`)
  if (posting.riding.length > 0)
    out.write(`${posting.riding.length} question(s) ride the pull request's evidence comment\n`)
  return 0
}

function requeueCommand(argv: string[], out: Writer): Promise<number> {
  const flags = parseFlags(argv)
  return runRequeue({
    keys: flags.list('keys'),
    keysFromDiff: flags.string('keys-from-diff'),
    profile: flags.string('profile'),
    repository: flags.string('repository'),
    apiRoot: flags.string('api-root'),
    tokenEnv: flags.string('token-env'),
  }).then((targets) => {
    for (const pr of targets) out.write(`re-queued pull request #${pr}\n`)
    return 0
  })
}

async function runRequeue(
  opts: { keys: string[] | undefined; keysFromDiff: string | undefined; profile?: string | undefined; repository?: string | undefined; apiRoot?: string | undefined; tokenEnv?: string | undefined },
): Promise<number[]> {
  let keys = opts.keys
  if (opts.keysFromDiff !== undefined) {
    let args: string[]
    try {
      args = stubDiffArgs(opts.keysFromDiff, opts.profile)
    } catch (error) {
      throw new GitHubClientError(`qare-action requeue: ${error instanceof Error ? error.message : String(error)}`)
    }
    const diff = await execFileAsync('git', args).then(
      (result) => result.stdout,
      (error: unknown) => {
        throw new GitHubClientError(
          `qare-action requeue could not read the stub diff for ${JSON.stringify(opts.keysFromDiff)}: git diff --unified=0 <spec> -- ${args.at(-1) ?? ''} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      },
    )
    keys = stubKeysFromDiffText(diff)
  }
  if (keys === undefined || keys.length === 0) {
    throw new GitHubClientError('qare-action requeue needs --keys <host,host,...> or --keys-from-diff <base>...<head> [--profile <dir>]')
  }
  const client = new GitHubClient({ repository: opts.repository, apiRoot: opts.apiRoot, tokenEnv: opts.tokenEnv })
  return requeueUnblocked(client, keys)
}

interface Flags {
  string(name: string): string | undefined
  number(name: string): number | undefined
  list(name: string): string[] | undefined
}

function sweepReportCommand(argv: string[], out: Writer): Promise<number> {
  const flags = parseFlags(argv)
  return runSweepReport({
    from: flags.string('from'),
    repository: flags.string('repository'),
    apiRoot: flags.string('api-root'),
    tokenEnv: flags.string('token-env'),
  }).then((published) => {
    out.write(`status issue #${published.status}\n`)
    for (const [fingerprint, issue] of published.findings)
      out.write(`finding ${fingerprint} filed as #${issue}\n`)
    return 0
  })
}

async function runSweepReport(
  opts: { from: string | undefined; repository?: string | undefined; apiRoot?: string | undefined; tokenEnv?: string | undefined },
): Promise<{ status: number; findings: Array<[string, number]> }> {
  if (opts.from === undefined || opts.from === '')
    throw new GitHubClientError('qare-action sweep-report needs --from <path to sweep payload>')
  const payload = parseSweepPayload(JSON.parse(await readFile(opts.from, 'utf8')))
  const client = new GitHubClient({ repository: opts.repository, apiRoot: opts.apiRoot, tokenEnv: opts.tokenEnv })
  return await publishSweep(client, payload)
}

function parseFlags(argv: string[]): Flags {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg.startsWith('--')) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new GitHubClientError(`qare-action needs a value after ${arg}`)
      }
      values.set(arg.slice(2), value)
      i += 1
    }
  }
  return {
    string: (name) => values.get(name),
    number: (name) => {
      const raw = values.get(name)
      if (raw === undefined) return undefined
      const parsed = Number(raw)
      if (!Number.isInteger(parsed)) throw new GitHubClientError(`--${name} must be an integer (got ${JSON.stringify(raw)})`)
      return parsed
    },
    list: (name) => {
      const raw = values.get(name)
      if (raw === undefined) return undefined
      return raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
