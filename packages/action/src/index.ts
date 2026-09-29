import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { loadResult, VERSION } from '@qare/core'
import { GitHubClient, GitHubClientError } from './github.js'
import { GitHubQaAssetsPusher } from './qa-assets.js'
import { fileRefusalStubs, GitHubStubIssuePoster } from './stub-issues.js'
import { requeueUnblocked, stubKeysFromDiffText } from './requeue.js'
import { GitHubEvidencePoster, postEvidence } from './post-evidence.js'
import { deliverIngest, IngestDeliveryError } from './ingest-deliver.js'
import { loadQuestions, postQuestions } from './post-questions.js'
import { parseSweepPayload, publishSweep } from './sweep-report.js'
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
  } catch (error) {
    err.write(error instanceof Error ? `${error.name}: ${error.message}\n` : `${String(error)}\n`)
    return 1
  }
  entry(out)
  if (command !== undefined) {
    err.write(`unknown command ${JSON.stringify(command)}: qare-action understands "stub-issues", "requeue", "post-evidence", "ingest-deliver", "post-questions" and "sweep-report"\n`)
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
  const author = flags.string('author')
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
  const author = flags.string('author') || undefined
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
    repository: flags.string('repository'),
    apiRoot: flags.string('api-root'),
    tokenEnv: flags.string('token-env'),
  }).then((targets) => {
    for (const pr of targets) out.write(`re-queued pull request #${pr}\n`)
    return 0
  })
}

async function runRequeue(
  opts: { keys: string[] | undefined; keysFromDiff: string | undefined; repository?: string | undefined; apiRoot?: string | undefined; tokenEnv?: string | undefined },
): Promise<number[]> {
  let keys = opts.keys
  if (opts.keysFromDiff !== undefined) {
    const diff = await execFileAsync('git', ['diff', '--unified=0', opts.keysFromDiff, '--', '.qa/']).then(
      (result) => result.stdout,
      (error: unknown) => {
        throw new GitHubClientError(
          `qare-action requeue could not read the stub diff for ${JSON.stringify(opts.keysFromDiff)}: git diff --unified=0 <spec> -- .qa/ failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      },
    )
    keys = stubKeysFromDiffText(diff)
  }
  if (keys === undefined || keys.length === 0) {
    throw new GitHubClientError('qare-action requeue needs --keys <host,host,...> or --keys-from-diff <base>...<head>')
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
