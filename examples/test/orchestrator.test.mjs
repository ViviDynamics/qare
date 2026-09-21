import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadResult, reactToResult } from '../orchestrator.mjs'

const PASSED = {
  schemaVersion: '1',
  verdict: 'passed',
  criteria: [
    {
      id: 'card-4821-2',
      outcome: 'proven',
      evidence: ['checks/card-4821-2/0/stdout.txt', 'checks/card-4821-2/0/stderr.txt'],
    },
  ],
  job: { id: 'card-4821' },
}

const FAILED = {
  schemaVersion: '1',
  verdict: 'failed',
  criteria: [
    { id: 'card-4821-1', outcome: 'failed', evidence: ['checks/card-4821-1/0/stdout.txt'] },
    { id: 'card-4821-2', outcome: 'proven', evidence: ['checks/card-4821-2/0/stdout.txt'] },
  ],
  job: { id: 'card-4821' },
}

const BLOCKED = {
  schemaVersion: '1',
  verdict: 'blocked',
  criteria: [{ id: 'card-4821-1', outcome: 'unverified', reason: 'compose up exited 1' }],
  job: { id: 'card-4821' },
}

const REFUSED = {
  schemaVersion: '1',
  verdict: 'refused',
  criteria: [{ id: 'card-4821-1', outcome: 'unverified', reason: 'missing stub: billing' }],
  job: { id: 'card-4821' },
}

const WAIVED = {
  schemaVersion: '1',
  verdict: 'waived',
  criteria: [{ id: 'card-4821-1', outcome: 'unverified', reason: 'waived by @maintainer' }],
  waived: [{ criterionId: 'card-4821-1', by: '@maintainer' }],
  job: { id: 'card-4821' },
}

function capture() {
  const out = []
  const err = []
  return {
    out,
    err,
    writers: {
      out: { write: (chunk) => out.push(chunk) },
      err: { write: (chunk) => err.push(chunk) },
    },
  }
}

test('a passed run reacts with exit 0 and prints the evidence paths', () => {
  const captured = capture()
  const code = reactToResult(PASSED, captured.writers)
  assert.equal(code, 0)
  assert.match(captured.out.join(''), /QARE_PASS:/)
  assert.match(captured.out.join(''), /checks\/card-4821-2\/0\/stdout\.txt/)
  assert.match(captured.out.join(''), /checks\/card-4821-2\/0\/stderr\.txt/)
})

test('a failed run reacts with exit 1 and names the failed criterion ids', () => {
  const captured = capture()
  const code = reactToResult(FAILED, captured.writers)
  assert.equal(code, 1)
  assert.match(captured.err.join(''), /QARE_FAILED:/)
  assert.match(captured.err.join(''), /card-4821-1/)
  assert.doesNotMatch(captured.err.join(''), /card-4821-2/)
})

test('a blocked run reacts with exit 2 and names the environment reason', () => {
  const captured = capture()
  const code = reactToResult(BLOCKED, captured.writers)
  assert.equal(code, 2)
  assert.match(captured.err.join(''), /QARE_BLOCKED:/)
  assert.match(captured.err.join(''), /compose up exited 1/)
})

test('a refused run reacts with exit 3 and names the refusal reason', () => {
  const captured = capture()
  const code = reactToResult(REFUSED, captured.writers)
  assert.equal(code, 3)
  assert.match(captured.err.join(''), /QARE_REFUSED:/)
  assert.match(captured.err.join(''), /missing stub: billing/)
})

test('a waived run is not a pass: it fails closed with exit 5 and names the waiver', () => {
  const captured = capture()
  const code = reactToResult(WAIVED, captured.writers)
  assert.equal(code, 5)
  assert.match(captured.err.join(''), /QARE_WAIVED:/)
  assert.match(captured.err.join(''), /@maintainer/)
  assert.doesNotMatch(captured.out.join(''), /QARE_PASS:/)
})

test('malformed result text is rejected with a named error, never guessed', () => {
  assert.throws(() => loadResult('not json at all {'), /result\.json is not valid JSON/)
  assert.throws(() => loadResult('[]'), /must be a JSON object/)
  assert.throws(() => loadResult('{"verdict":"passed","criteria":[]}'), /schemaVersion/)
})

test('an unknown schemaVersion is rejected, naming the version this tool understands', () => {
  const text = JSON.stringify({ ...PASSED, schemaVersion: '9' })
  assert.throws(() => loadResult(text), /unknown schemaVersion "9"/)
  assert.throws(() => loadResult(text), /this tool understands "1"/)
})

test('an unknown verdict or a criteria-less result is rejected', () => {
  assert.throws(
    () => loadResult(JSON.stringify({ ...PASSED, verdict: 'green' })),
    /unknown verdict "green"/,
  )
  assert.throws(() => loadResult(JSON.stringify({ schemaVersion: '1', verdict: 'passed' })), /criteria/)
})
