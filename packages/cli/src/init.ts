import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { GitHubClient, GitHubStubIssuePoster } from '@qare/action'
import { INIT_WORKFLOW_PATH, PIPELINE_WORKFLOW, planInit, readinessInventory, stubIssueDraft, stubIssueMarker } from '@qare/core'
import type { InitFile, StubIssueDraft } from '@qare/core'

interface Writer {
  write(chunk: string): void
}

/** The one thing init asks of GitHub: file a stub issue unless it is there. */
export interface InitIssuePoster {
  fileIfMissing(draft: StubIssueDraft): Promise<number>
}

export interface InitDeps {
  /** The poster for a repository; the default reaches GitHub with the token in the environment. */
  poster?: (repository: string) => InitIssuePoster
}

const USAGE = 'qare init [path] [--target <url>] [--health <path>] [--service <name>] [--model <name>] [--file-issues <owner/name>]'
const VALUE_FLAGS = ['--target', '--health', '--service', '--model', '--file-issues']

const HELP = `${USAGE}
  onboard a repository: run the readiness inventory, then write a starting .qa/ and the
  workflow that calls the qare pipeline. Never overwrites: an existing .qa/ or workflow is
  left alone, and init prints what it would have written.
  --target <url>              check an app that is already running, instead of booting one
  --health <path>             the path the health check asks for, which must answer 200
  --service <name>            the compose service that is the application
  --model <name>              the model the pipeline asks (the workflow's nare-model)
  --file-issues <owner/name>  file an issue for every missing stub (needs GITHUB_TOKEN or GH_TOKEN)
`

function githubPoster(repository: string): InitIssuePoster {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token === undefined || token === '')
    throw new Error('qare init --file-issues needs a GitHub token that can write issues: set GITHUB_TOKEN or GH_TOKEN')
  return new GitHubStubIssuePoster(new GitHubClient({ repository, token }))
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined
}

/** The branch `origin/HEAD` names: the one whose pushes re-queue refused pull requests. */
async function defaultBranch(repo: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    const branch = stdout.trim().replace(/^origin\//, '')
    return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ? branch : undefined
  } catch {
    return undefined
  }
}

/** A workflow that already calls the pipeline, whatever its file is named. */
async function existingCaller(repo: string): Promise<string | undefined> {
  if (await exists(join(repo, INIT_WORKFLOW_PATH))) return INIT_WORKFLOW_PATH
  const dir = join(repo, dirname(INIT_WORKFLOW_PATH))
  for (const name of (await readdir(dir).catch(() => [])).sort()) {
    if (!/\.ya?ml$/.test(name)) continue
    const text = await readFile(join(dir, name), 'utf8').catch(() => '')
    if (text.includes(`${PIPELINE_WORKFLOW}@`)) return `${dirname(INIT_WORKFLOW_PATH)}/${name}`
  }
  return undefined
}

async function writeNew(repo: string, file: InitFile, out: Writer): Promise<void> {
  const path = join(repo, file.path)
  await mkdir(dirname(path), { recursive: true })
  // `wx` fails on a file that appeared since the check: never overwrite.
  await writeFile(path, file.content, { encoding: 'utf8', flag: 'wx' })
  out.write(`wrote ${file.path}\n`)
}

function show(file: InitFile, out: Writer): void {
  out.write(`--- ${file.path}\n`)
  for (const line of file.content.replace(/\n$/, '').split('\n')) out.write(line === '' ? '\n' : `  ${line}\n`)
}

/**
 * `qare init [path]` (#146): the readiness inventory, then a starting `.qa/`
 * and the caller workflow, then every gap that is left as a next step. Exit 0
 * when the repository is onboarded as far as init can take it; 4 when the
 * invocation is wrong or there is nothing init could write.
 */
export async function initCommand(argv: string[], out: Writer, err: Writer, deps: InitDeps = {}): Promise<number> {
  try {
    const flags: Record<string, string> = {}
    let path: string | undefined
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] as string
      if (arg === '--help' || arg === '-h') {
        out.write(HELP)
        return 0
      }
      if (VALUE_FLAGS.includes(arg)) {
        const value = argv[i + 1]
        if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value\nusage: ${USAGE}`)
        flags[arg] = value
        i += 1
        continue
      }
      if (arg.startsWith('-')) throw new Error(`qare init does not take ${arg}\nusage: ${USAGE}`)
      if (path !== undefined) throw new Error(`qare init accepts at most one path\nusage: ${USAGE}`)
      path = arg
    }
    const repo = path === undefined ? process.cwd() : resolve(path)

    // Everything that can refuse does so before the first file is written.
    const repository = flags['--file-issues']
    if (repository !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(repository))
      throw new Error(`--file-issues takes the repository as owner/name, not ${JSON.stringify(repository)}`)
    const poster = repository === undefined ? undefined : (deps.poster ?? githubPoster)(repository)
    const branch = await defaultBranch(repo)
    const plan = await planInit(repo, {
      ...(flags['--target'] === undefined ? {} : { target: flags['--target'] }),
      ...(flags['--health'] === undefined ? {} : { health: flags['--health'] }),
      ...(flags['--service'] === undefined ? {} : { service: flags['--service'] }),
      ...(flags['--model'] === undefined ? {} : { model: flags['--model'] }),
      ...(branch === undefined ? {} : { defaultBranch: branch }),
    })

    if (await exists(join(repo, '.qa'))) {
      out.write('kept .qa/ (it exists, and init never overwrites); it would have written:\n')
      for (const file of plan.profile) show(file, out)
    } else {
      for (const file of plan.profile) await writeNew(repo, file, out)
    }
    const caller = await existingCaller(repo)
    if (caller === undefined) {
      await writeNew(repo, plan.workflow, out)
    } else {
      out.write(
        caller === plan.workflow.path
          ? `kept ${caller} (it exists, and init never overwrites); it would have written:\n`
          : `kept ${caller} (it already calls the qare pipeline); init would have written ${plan.workflow.path}:\n`,
      )
      show(plan.workflow, out)
    }

    // The next steps are the readiness report's gaps for what is there now:
    // the same list `qare readiness` prints, so the two cannot disagree.
    const inventory = await readinessInventory(repo)
    const steps = [
      ...inventory.gaps,
      ...(caller === undefined ? [`add the repository secret ${plan.secret}: the workflow reads the model key from it`] : []),
    ]
    out.write('next steps\n')
    for (const step of steps) out.write(`- ${step}\n`)
    if (steps.length === 0) out.write('- none: qare readiness finds no gaps\n')

    if (inventory.stubGaps.length === 0) return 0
    const drafts = inventory.stubGaps.map((gap) =>
      stubIssueDraft(
        { host: gap.host, port: gap.port, protocol: gap.protocol, count: gap.hits },
        { files: gap.files, ...(gap.service === undefined ? {} : { service: gap.service, composeService: gap.composeService }) },
      ),
    )
    if (poster === undefined || repository === undefined) {
      out.write('stub issues to file (qare init --file-issues <owner/name> files them)\n')
      for (const draft of drafts) out.write(`- ${draft.title} (${stubIssueMarker(draft.key)})\n`)
      return 0
    }
    out.write(`stub issues in ${repository}\n`)
    for (const draft of drafts) out.write(`- #${await poster.fileIfMissing(draft)} ${draft.title} (${stubIssueMarker(draft.key)})\n`)
    return 0
  } catch (error) {
    err.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`)
    return 4
  }
}
