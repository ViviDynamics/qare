// Exercise the core image's installed nare through qare's real subprocess seam.
// No model credentials or external model service are needed:
// docker run --rm -i qare-core:nare-2026.10.28 node --input-type=module < scripts/nare-compat.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { NareAgentRunner } = await import('/opt/qare/lib/packages/core/dist/index.js')
const versions = JSON.parse(execFileSync('python3', ['-c',
  'import json, importlib.metadata as m; print(json.dumps({p: m.version(p) for p in ["nare", "pillow", "opentelemetry-api"]}))',
], { encoding: 'utf8' }))
assert.equal(versions.nare, '2026.10.28')
assert.equal(versions.pillow, '13.0.0')
const contract = JSON.parse(execFileSync('nare', ['contract'], { encoding: 'utf8' }))
assert.equal(contract.contract, 2)
console.log('installed versions:', JSON.stringify(versions))

let replies = []
let requests = []
const server = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json')
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.end(JSON.stringify({ data: [] }))
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  requests.push(JSON.parse(Buffer.concat(chunks).toString()))
  const reply = replies.shift()
  if (!reply) {
    response.writeHead(500)
    response.end(JSON.stringify({ error: 'unplanned model turn' }))
    return
  }
  response.end(JSON.stringify({
    id: 'fixture', object: 'chat.completion', model: 'fixture',
    choices: [{ index: 0, ...reply }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const root = await mkdtemp(join(tmpdir(), 'qare-nare-compat-'))
const runner = new NareAgentRunner({
  root,
  env: {
    NARE_PROVIDER: 'openai', NARE_MODEL: 'fixture', NARE_STREAM: 'false',
    NARE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    OPENAI_API_KEY: 'local-fixture',
  },
})
const base = {
  prompt: 'Return the fixture verdict.', system: 'Use only the supplied evidence.',
  toolPolicy: 'none', budget: { maxOutputTokens: 512 },
  outputSchema: JSON.stringify({
    type: 'object', properties: { verdict: { type: 'string' } },
    required: ['verdict'], additionalProperties: false,
  }),
}
const answer = (text, finish_reason = 'stop') => ({
  message: { role: 'assistant', content: text }, finish_reason,
})
const reset = (...planned) => { requests = []; replies = planned }
try {
  reset(answer('{"verdict":"pass"}'))
  const completed = await runner.run(base)
  assert.equal(completed.status, 'completed')
  assert.deepEqual(JSON.parse(completed.output), { verdict: 'pass' })
  assert.deepEqual(completed.usage, { inputTokens: 10, outputTokens: 5 })
  assert.equal(requests[0].messages[0].content, base.system)
  assert.equal(requests[0].tools, undefined)
  // The new schema-constrained mode stays opt-in, preserving backend support.
  assert.equal(requests[0].response_format, undefined)
  console.log('PASS: contract 2 result, schema output, usage and qare persona')

  reset(answer('not JSON'), answer('{"verdict":"corrected"}'))
  const corrected = await runner.run(base)
  assert.equal(corrected.status, 'completed')
  assert.deepEqual(JSON.parse(corrected.output), { verdict: 'corrected' })
  assert.equal(requests.length, 2)
  console.log('PASS: schema correction through real nare')

  await writeFile(join(root, 'evidence.txt'), 'fixture evidence')
  reset({
    message: { role: 'assistant', content: null, tool_calls: [{
      id: 'read-evidence', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: join(root, 'evidence.txt') }) },
    }] }, finish_reason: 'tool_calls',
  }, answer('{"verdict":"read"}'))
  const read = await runner.run({ ...base, toolPolicy: 'read-only', system: '' })
  assert.equal(read.status, 'completed')
  assert.deepEqual(JSON.parse(read.output), { verdict: 'read' })
  assert.deepEqual(requests[0].tools.map((tool) => tool.function.name), ['read'])
  assert.ok(requests[0].messages.every((message) => message.role !== 'system'))
  assert.ok(requests[1].messages.some((message) => message.role === 'tool' && message.content.includes('fixture evidence')))
  console.log('PASS: read-only tool execution, no ask/bash/write, empty persona preserved')

  reset(answer('not JSON'), answer('still not JSON'))
  const invalid = await runner.run(base)
  assert.equal(invalid.status, 'failed')
  assert.equal(invalid.output, undefined)
  assert.equal(requests.length, 2)
  console.log('PASS: schema violation fails closed')

  reset(answer('partial', 'length'))
  const truncated = await runner.run(base)
  assert.equal(truncated.status, 'failed')
  assert.equal(truncated.stopReason, 'max_tokens')
  assert.equal(truncated.output, undefined)
  console.log('PASS: truncated result fails closed')
  assert.equal(replies.length, 0)
} finally {
  await rm(root, { recursive: true, force: true })
  await new Promise((resolve) => server.close(resolve))
}
