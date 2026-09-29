import { afterEach, beforeEach, expect, test } from 'vitest'
import { questionIdFor, questionMarker, type ResolutionQuestion } from '@qare/core'
import { GitHubClient } from '../src/github.js'
import { postEvidence } from '../src/post-evidence.js'
import { GitHubEvidencePoster } from '../src/post-evidence.js'
import { loadQuestions, postQuestions } from '../src/post-questions.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

const SHA = 'a'.repeat(40)

let fake: FakeGithub
let client: GitHubClient

beforeEach(async () => {
  fake = await startFakeGithub()
  fake.issues.set(12, { number: 12, title: 'a pull request', body: '', comments: [] })
  fake.issues.set(154, { number: 154, title: 'an issue with criteria', body: '', comments: [] })
  client = new GitHubClient({ repository: 'octocat/qare', token: FAKE_TOKEN, apiRoot: fake.url })
})

afterEach(async () => {
  await fake.close()
})

function question(overrides: Partial<ResolutionQuestion> = {}): ResolutionQuestion {
  return {
    id: questionIdFor('export-csv'),
    criterion: 'export-csv',
    recommendation: 'supersede',
    reason: 'the model read the diff as rewording the notice',
    source: { kind: 'criteria-issue', issue: 154, author: 'hana' },
    ...overrides,
  }
}

test('a conflict in the criteria themselves is asked once, on the issue, mentioning its author', async () => {
  const posting = await postQuestions(client, [question()])

  expect(posting.posted).toHaveLength(1)
  expect(posting.riding).toEqual([])
  const comments = fake.issues.get(154)?.comments ?? []
  expect(comments).toHaveLength(1)
  expect(comments[0]).toContain(questionMarker(question().id))
  expect(comments[0]).toContain('cc @hana')
  expect(comments[0]).toContain('the old rule is superseded on purpose')

  const again = await postQuestions(client, [question()])
  expect(again.posted).toEqual([])
  expect(again.skipped).toHaveLength(1)
  expect(fake.issues.get(154)?.comments).toHaveLength(1)
})

test('a sweep question goes to the finding issue, mentioning the person the finding blames', async () => {
  const sweep = question({
    id: questionIdFor('export-csv', 'payout-email-only'),
    replacement: 'payout-email-only',
    source: { kind: 'sweep', finding: 154, blame: 'jason' },
  })
  const posting = await postQuestions(client, [sweep])

  expect(posting.posted).toHaveLength(1)
  const comment = (fake.issues.get(154)?.comments ?? []).find((body) => body.includes(questionMarker(sweep.id)))
  expect(comment).toContain('cc @jason')
  expect(comment).toContain('`payout-email-only` replacing `export-csv`')
})

test('a question a pull request introduces is never posted on an issue; it rides the evidence comment', async () => {
  const riding = question({ source: { kind: 'pull-request' } })
  const posting = await postQuestions(client, [riding])

  expect(posting.posted).toEqual([])
  expect(posting.riding).toEqual([riding])
  expect(fake.issues.get(12)?.comments ?? []).toHaveLength(0)
  expect(fake.issues.get(154)?.comments ?? []).toHaveLength(0)
})

test('the evidence comment carries the questions the pull request introduces', async () => {
  fake.issues.set(12, { number: 12, title: 'a pull request', body: '', comments: [] })
  const riding = question({ source: { kind: 'pull-request' }, recommendation: 'regression' })
  await postEvidence(
    new GitHubEvidencePoster(client, 12, SHA),
    {
      schemaVersion: '1',
      verdict: 'blocked',
      criteria: [{ id: 'export-csv', outcome: 'unverified', reason: 'held for an open question' }],
    },
    { questions: [riding] },
  )

  const comment = fake.issues.get(12)?.comments[0] ?? ''
  expect(comment).toContain(questionMarker(riding.id))
  expect(comment).toContain('unintended regression')
})

test('the questions file is read back with every field checked', async () => {
  const report = {
    schemaVersion: '1',
    settled: [],
    questions: [question()],
    held: { criteria: ['export-csv'], verdict: 'blocked' },
  }
  expect(loadQuestions(JSON.stringify(report))).toHaveLength(1)

  expect(() => loadQuestions(JSON.stringify({ questions: [question({ id: 'not-an-id' })] }))).toThrow(
    /is not a question id/,
  )
  expect(() => loadQuestions(JSON.stringify({ questions: [question({ recommendation: 'maybe' as never })] }))).toThrow(
    /neither "supersede" nor "regression"/,
  )
  expect(() => loadQuestions(JSON.stringify({ questions: [question({ source: { kind: 'criteria-issue', issue: 154, author: 'not a login!' } })] }))).toThrow(
    /must be a GitHub login/,
  )
  expect(() => loadQuestions('[]')).toThrow(/a resolution report with a "questions" array/)
})
