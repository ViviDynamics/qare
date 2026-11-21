// Exercise the core image's installed nare through qare's real subprocess seam.
// No model credentials or external model service are needed:
// docker run --rm -i qare-core:nare-2026.11.107 node --input-type=module < scripts/nare-compat.mjs
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
assert.equal(versions.nare, '2026.11.107')
assert.equal(versions.pillow, '13.0.0')
const contract = JSON.parse(execFileSync('nare', ['contract'], { encoding: 'utf8' }))
assert.equal(contract.contract, 3)
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
const env = {
  NARE_PROVIDER: 'openai', NARE_MODEL: 'fixture', NARE_STREAM: 'false',
  NARE_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  OPENAI_API_KEY: 'local-fixture',
}
const runner = new NareAgentRunner({ root, env })
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
  console.log('PASS: contract 3 result, schema output, usage and qare persona')

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

  // A prompt past the 131071 bytes one argument carries on Linux reaches the
  // model byte for byte (#401): multibyte text, CRLF and a trailing newline
  // included. What bounds it now is the context window nare measures against,
  // so this runner names one that holds it.
  const large = `${'diff line ü ✓\r\n'.repeat(12000)}end\n`
  assert.ok(Buffer.byteLength(large, 'utf8') > 131071)
  // nare follows the task with its schema instruction, so the user message is
  // compared against what nare sends for a short prompt under the same schema.
  const wide = new NareAgentRunner({ root, env: { ...env, NARE_CONTEXT_WINDOW: '1000000' } })
  const userText = () => requests[0].messages.find((message) => message.role === 'user').content
  reset(answer('{"verdict":"short"}'))
  assert.equal((await wide.run(base)).status, 'completed')
  assert.ok(userText().startsWith(base.prompt))
  const suffix = userText().slice(base.prompt.length)
  reset(answer('{"verdict":"large"}'))
  const big = await wide.run({ ...base, prompt: large })
  assert.equal(big.status, 'completed')
  assert.deepEqual(JSON.parse(big.output), { verdict: 'large' })
  assert.equal(userText(), large + suffix)
  // Without a window that holds it, the same prompt stops on the window, by
  // name, and never reaches the model: the window is the bound, not argv.
  reset(answer('{"verdict":"unreached"}'))
  const narrow = await runner.run({ ...base, prompt: large })
  assert.equal(narrow.status, 'failed')
  assert.equal(narrow.stopReason, 'context')
  assert.equal(requests.length, 0)
  replies = []
  console.log('PASS: a prompt past one argument\'s limit reaches the model intact, by file, and the context window bounds it')

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
