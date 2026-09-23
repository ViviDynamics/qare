import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { ProfileMissingError, ProfileValidationError, loadProfile, runJob, type Job } from '../src/index.js'

async function repo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'qare-noprofile-'))
}

function job(repoPath: string): Job {
  return {
    id: 'pr-1',
    repoPath,
    baseRef: 'a',
    headRef: 'b',
    profile: { path: '.qa' },
    criteria: [
      { id: 'c1', text: 'logs in', checks: [{ kind: 'command', run: 'true' }] },
      { id: 'c2', text: 'renders', checks: [{ kind: 'command', run: 'true' }] },
    ],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

test('a repository with no .qa at all is refused, not a usage error', async () => {
  // A repository that has not onboarded is not a caller mistake, and no
  // change in the pull request can fix it. Refused says that; a thrown
  // validation error says the caller did something wrong.
  const path = await repo()

  const { result } = await runJob(job(path))

  expect(result.verdict).toBe('refused')
})

test('every criterion is reported, unverified, rather than dropped', async () => {
  const path = await repo()

  const { result } = await runJob(job(path))

  expect(result.criteria.map((criterion) => [criterion.id, criterion.outcome])).toEqual([
    ['c1', 'unverified'],
    ['c2', 'unverified'],
  ])
})

test('the refusal names what is missing, so onboarding has a first step', async () => {
  const path = await repo()

  const { result } = await runJob(job(path))

  const reason = (result.criteria[0] as { reason: string }).reason
  expect(reason).toMatch(/QA\.md|\.qa/)
})

test('the refused result is written as evidence like any other run', async () => {
  const path = await repo()

  await runJob(job(path))

  const written = JSON.parse(await readFile(join(path, 'evidence', 'result.json'), 'utf8'))
  expect(written.verdict).toBe('refused')
})

test('a partly onboarded repository is refused too, naming the first gap', async () => {
  const path = await repo()
  await mkdir(join(path, '.qa'), { recursive: true })
  await writeFile(join(path, '.qa', 'QA.md'), '# QA\n', 'utf8')

  const { result } = await runJob(job(path))

  expect(result.verdict).toBe('refused')
  expect((result.criteria[0] as { reason: string }).reason).toMatch(/fixtures/)
})

test('a profile that exists but is malformed is still an error somebody made', async () => {
  // Absence is an outcome; a broken file is a mistake. They must stay
  // distinguishable, or a typo in config.yml would quietly read as "not
  // onboarded yet" forever.
  const path = await repo()
  const qa = join(path, '.qa')
  await mkdir(join(qa, 'fixtures'), { recursive: true })
  await mkdir(join(qa, 'stubs'), { recursive: true })
  await writeFile(join(qa, 'QA.md'), '# QA\n', 'utf8')
  await writeFile(join(qa, 'config.yml'), 'app: [unclosed\n', 'utf8')

  await expect(runJob(job(path))).rejects.toThrow(ProfileValidationError)
  await expect(runJob(job(path))).rejects.not.toThrow(ProfileMissingError)
})

test('the missing-profile error is a validation error, so existing handlers still catch it', async () => {
  const path = await repo()

  await expect(loadProfile(join(path, '.qa'))).rejects.toThrow(ProfileMissingError)
  await expect(loadProfile(join(path, '.qa'))).rejects.toThrow(ProfileValidationError)
})
