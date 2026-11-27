import { expect, test } from 'vitest'
import { bootApp, composeErrorTail, loadProfile, type QaProfile } from '../src/index.js'

// #412: on the website pilot a compose up that failed said only "compose up
// exited 1". The error itself, "failed to register layer: ... operation not
// permitted", was the last of 104 lines of provision output, the rest pull
// progress.

const PULL_THEN_FAIL = [
  '[+] Pulling 12/13',
  ' ⠿ s3 Pulling                                                   41.2s',
  '   4f4fb700ef54 Pulling fs layer                                  0.2s',
  '   a2abf6c4d29d Waiting                                           0.3s',
  '   a2abf6c4d29d Downloading [=====>          ]  12.1MB/31.4MB     3.1s',
  '   a2abf6c4d29d Verifying Checksum                                5.0s',
  '   a2abf6c4d29d Download complete                                 5.0s',
  '   a2abf6c4d29d Extracting [==>             ]  1.1MB/31.4MB       5.2s',
  '   4f4fb700ef54 Pull complete                                     6.0s',
  '   9d0cc0c0e1aa Already exists                                    0.0s',
  ' ✔ db Pulled                                                      8.1s',
  '\u001b[31merror\u001b[0m pulling image amazon/aws-cli',
  'failed to register layer: unshare: operation not permitted',
].join('\n')

async function profile(): Promise<QaProfile> {
  return loadProfile(new URL('../fixtures/qa-valid/.qa', import.meta.url).pathname)
}

test('the tail drops pull progress and colour, and keeps the error lines (#412)', () => {
  expect(composeErrorTail(PULL_THEN_FAIL)).toEqual(['error pulling image amazon/aws-cli', 'failed to register layer: unshare: operation not permitted'])
})

test('the tail keeps the last five lines, each cut to a readable length (#412)', () => {
  const many = Array.from({ length: 9 }, (_, index) => `error ${index}: ${'x'.repeat(400)}`).join('\r\n')
  const tail = composeErrorTail(many)
  expect(tail).toHaveLength(5)
  expect(tail[0]?.startsWith('error 4: ')).toBe(true)
  for (const line of tail) expect(line.length).toBeLessThanOrEqual(241)
})

test('output that is all progress, or empty, has no tail (#412)', () => {
  expect(composeErrorTail('')).toEqual([])
  expect(composeErrorTail('[+] Running 3/3\n ✔ Container qare-x-db-1  Started  0.4s\n ✔ Network qare-x_default  Created  0.1s\n')).toEqual([])
})

test('a compose up that fails names the last error lines in its reason, and keeps the whole output as logs (#412)', async () => {
  const outcome = await bootApp(await profile(), {
    runCompose: async (args) => (args.includes('up') ? { code: 1, stdout: '', stderr: PULL_THEN_FAIL } : { code: 0, stdout: '', stderr: '' }),
    egressImage: '',
  })

  expect(outcome.kind).toBe('blocked')
  expect(outcome.reason).toBe('compose up exited 1; its output ended: error pulling image amazon/aws-cli | failed to register layer: unshare: operation not permitted')
  expect(outcome.logs).toContain('Pulling fs layer')
})

test('a compose build that fails names the last error lines too (#412)', async () => {
  const outcome = await bootApp(await profile(), {
    runCompose: async () => ({ code: 17, stdout: '#8 [web 4/9] RUN bundle install\n', stderr: 'failed to solve: process "bundle install" did not complete successfully: exit code: 5\n' }),
    egressImage: '',
  })

  expect(outcome.reason).toBe(
    'compose build exited 17: the profile\'s images did not build, so nothing was booted; its output ended: #8 [web 4/9] RUN bundle install | failed to solve: process "bundle install" did not complete successfully: exit code: 5',
  )
})

test('a compose up with no output keeps its reason as it was (#412)', async () => {
  const outcome = await bootApp(await profile(), {
    runCompose: async (args) => (args.includes('up') ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    egressImage: '',
  })

  expect(outcome.reason).toBe('compose up exited 1')
})
