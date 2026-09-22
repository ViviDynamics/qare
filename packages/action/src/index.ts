import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { loadResult, VERSION } from '@qare/core'
import { GitHubClient, GitHubClientError } from './github.js'
import { fileRefusalStubs, GitHubStubIssuePoster } from './stub-issues.js'
import { requeueUnblocked, stubKeysFromDiffText } from './requeue.js'

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
  } catch (error) {
    err.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  entry(out)
  if (command !== undefined) {
    err.write(`unknown command ${JSON.stringify(command)}: qare-action understands "stub-issues" and "requeue"\n`)
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
    if (filed === undefined) return 0
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
