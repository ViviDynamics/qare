import { questionMarker, renderQuestion, QUESTION_MARKER_PREFIX } from '@qare/core'
import type { ResolutionQuestion } from '@qare/core'
import { DEFAULT_AUTHOR } from './post-evidence.js'
import { GitHubClientError, type GitHubClient } from './github.js'

/**
 * Questions about the criteria themselves go where the criteria live: on the
 * linked issue, mentioning its author, or on a sweep finding's issue,
 * mentioning the person the finding blames (#41). A conflict a pull request
 * introduces rides that PR's evidence comment instead, so those questions are
 * never posted here.
 */
export interface QuestionPosting {
  /** Posted now, because no comment here carried the question yet. */
  posted: Array<{ issue: number; question: ResolutionQuestion }>
  /** Found already asked, so left alone: a question is asked once. */
  skipped: Array<{ issue: number; question: ResolutionQuestion }>
  /** Left for the pull request's evidence comment. */
  riding: ResolutionQuestion[]
}

/**
 * A GitHub login is [a-zA-Z0-9-], so a mention placed in a comment can name
 * nobody but a real account: anything else is refused rather than rendered,
 * or a crafted "login" could inject markup into the comment (#55).
 */
function isLogin(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(name)
}

function mentionLine(name: string | undefined, why: string): string {
  if (name === undefined) return ''
  if (!isLogin(name))
    throw new GitHubClientError(`${why} ${JSON.stringify(name)} is not a GitHub login, so it cannot be mentioned`)
  return `cc @${name}`
}

function targetOf(question: ResolutionQuestion): { issue: number; mention: string } {
  if (question.source.kind === 'criteria-issue')
    return { issue: question.source.issue, mention: mentionLine(question.source.author, "the issue's author") }
  if (question.source.kind === 'sweep')
    return { issue: question.source.finding, mention: mentionLine(question.source.blame, 'the person the finding blames') }
  throw new GitHubClientError(
    `question ${JSON.stringify(question.id)} is placed on a pull request; it rides the evidence comment and is not posted on an issue`,
  )
}

/**
 * Ask each question in its place, once. The marker in the comment body is
 * what "asked once" means in practice: before posting, the issue's comments
 * are read, and a comment of ours that already carries this question's marker
 * stands for it. Everything else about the question — the conflict, the
 * recommendation, the hold — is in the body, so the reader needs nothing else.
 */
export async function postQuestions(
  client: GitHubClient,
  questions: ResolutionQuestion[],
  author: string = DEFAULT_AUTHOR,
): Promise<QuestionPosting> {
  const posted: Array<{ issue: number; question: ResolutionQuestion }> = []
  const skipped: Array<{ issue: number; question: ResolutionQuestion }> = []
  const riding: ResolutionQuestion[] = []
  for (const question of questions) {
    if (question.source.kind === 'pull-request') {
      riding.push(question)
      continue
    }
    const { issue, mention } = targetOf(question)
    const marker = questionMarker(question.id)
    const existing = await client.listIssueComments(issue)
    if (existing.some((comment) => comment.user?.login === author && comment.body?.includes(marker))) {
      skipped.push({ issue, question })
      continue
    }
    const body = mention === '' ? renderQuestion(question) : `${renderQuestion(question)}\n\n${mention}`
    await client.postIssueComment(issue, body)
    posted.push({ issue, question })
  }
  return { posted, skipped, riding }
}

export { QUESTION_MARKER_PREFIX }

/**
 * The questions a resolution report carries, read back from disk. Every field
 * is validated here, because the file is data a comment is rendered from: an
 * id that is not one of ours, a recommendation that is not one of the two, or
 * a login that is not a login is refused, not rendered.
 */
export function loadQuestions(text: string): ResolutionQuestion[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new GitHubClientError(`the questions file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const report = isRecord(parsed) && Array.isArray(parsed.questions) ? parsed.questions : undefined
  if (report === undefined)
    throw new GitHubClientError('the questions file must be a resolution report with a "questions" array')
  return report.map((entry, index) => {
    const field = `questions[${index}]`
    if (!isRecord(entry)) throw new GitHubClientError(`${field} must be a JSON object`)
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!/^q-[0-9a-f]{16}$/.test(id))
      throw new GitHubClientError(`${field}.id ${JSON.stringify(entry.id)} is not a question id (q- followed by 16 hex characters)`)
    const criterion = nonEmpty(entry.criterion, `${field}.criterion`)
    const replacement = entry.replacement === undefined ? undefined : nonEmpty(entry.replacement, `${field}.replacement`)
    const recommendation = entry.recommendation
    if (recommendation !== 'supersede' && recommendation !== 'regression')
      throw new GitHubClientError(`${field}.recommendation ${JSON.stringify(recommendation)} is neither "supersede" nor "regression"`)
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '')
      throw new GitHubClientError(`${field}.reason must say why the recommendation holds`)
    return {
      id,
      criterion,
      ...(replacement === undefined ? {} : { replacement }),
      recommendation,
      reason: entry.reason,
      source: sourceOf(entry.source, field),
    }
  })
}

function sourceOf(value: unknown, field: string): ResolutionQuestion['source'] {
  if (!isRecord(value)) throw new GitHubClientError(`${field}.source must be a JSON object`)
  if (value.kind === 'pull-request') return { kind: 'pull-request' }
  if (value.kind === 'criteria-issue') {
    const issue = typeof value.issue === 'number' && Number.isInteger(value.issue) && value.issue > 0 ? value.issue : undefined
    if (issue === undefined) throw new GitHubClientError(`${field}.source.issue must be a positive integer`)
    const author = typeof value.author === 'string' && isLogin(value.author) ? value.author : undefined
    if (author === undefined) throw new GitHubClientError(`${field}.source.author must be a GitHub login, the issue's author`)
    return { kind: 'criteria-issue', issue, author }
  }
  if (value.kind === 'sweep') {
    const finding = typeof value.finding === 'number' && Number.isInteger(value.finding) && value.finding > 0 ? value.finding : undefined
    if (finding === undefined) throw new GitHubClientError(`${field}.source.finding must be a positive integer`)
    const blame = typeof value.blame === 'string' && isLogin(value.blame) ? value.blame : undefined
    return { kind: 'sweep', finding, ...(blame === undefined ? {} : { blame }) }
  }
  throw new GitHubClientError(`${field}.source.kind ${JSON.stringify(value.kind)} is not a placement this action posts`)
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new GitHubClientError(`${field} must be a non-empty string`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
