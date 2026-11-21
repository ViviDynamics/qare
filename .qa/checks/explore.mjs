import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './source.mjs'

// Executable checks of exploration in the pipeline (#377), run against the
// checkout without a build: the plan job's own step scripts with docker
// stubbed, and the checkout's core source through source.mjs, with a page
// standing in for the browser so no daemon, network, model or credential is
// needed. Each check prints what it observed. Scratch is restricted to
// .qa/checks/scratch.

const core = (file) => import(`../../packages/core/src/${file}`)
// The run module first: it loads the core's modules in the order they expect.
await core('run.ts')
const { planRun, FakeAgentRunner, startExplorationServer, startExplorationBridge, NareAgentRunner, validateProfileConfig } = await core('index.ts')
const root = fileURLToPath(new URL('../../', import.meta.url))
const scratch = fileURLToPath(new URL('./scratch/', import.meta.url))
mkdirSync(scratch, { recursive: true })
const { parse } = await import('yaml')
const workflow = parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8'))
const planSteps = workflow.jobs.plan.steps
const stepOf = (name) => {
  const found = planSteps.find((step) => step.name === name)
  assert.ok(found, `plan has no step ${name}`)
  return found
}
// The stubs are bash functions handed down in the environment, not files:
// the scratch directory a contained check gets may not be executable.
const stubs = {}
const tool = (name, body) => {
  stubs[`BASH_FUNC_${name}%%`] = `() { ${body}\n}`
}
const runScript = (script, dir, env) =>
  spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), ...stubs, ...env } })

const APP = ['http:', '//127.0.0.1:41377'].join('')
const SAVE_AT = 'document/main/button "Save"'
const tree = {
  role: 'document',
  states: {},
  path: 'document',
  children: [{ role: 'main', states: {}, path: 'document/main', children: [{ role: 'button', name: 'Save', states: {}, path: SAVE_AT, children: [] }] }],
}
function fakeApp() {
  let at = `${APP}/`
  return {
    observe: async () => ({ url: at, title: 'Settings' }),
    snapshot: async () => tree,
    navigate: async (target) => void (at = target),
    capture: async () => Buffer.from('png'),
  }
}
const completed = (output) => ({ status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output: JSON.stringify(output) })
const CRITERIA = [{ id: 'c1', text: 'saving the settings shows a confirmation' }]
const flowPlan = (element) => ({
  schemaVersion: '1',
  criteria: [{ id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'flow', name: 'save', actions: [{ action: 'open', url: '/settings' }, { action: 'click', element }, { action: 'assertText', text: 'Saved' }] }] }],
})
function rpc(endpoint, method, params) {
  return new Promise((resolve, reject) => {
    const target = new URL(endpoint)
    const outgoing = request({ hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (incoming) => {
      let raw = ''
      incoming.on('data', (chunk) => (raw += String(chunk)))
      incoming.on('end', () => resolve(JSON.parse(raw)))
    })
    outgoing.on('error', reject)
    outgoing.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
  })
}

const check = process.argv[2]
const dir = mkdtempSync(join(scratch, `explore-${check}-`))
try {
  if (check === 'pipeline') {
    // The profile switch: only explore: base turns the steps on.
    const read = stepOf('Read whether the profile explores')
    for (const config of ['explore: base', 'flavour: web', 'explore: off']) {
      mkdirSync(join(dir, '.qa'), { recursive: true })
      writeFileSync(join(dir, '.qa', 'config.yml'), `app: {}\n${config}\n`)
      writeFileSync(join(dir, 'output'), '')
      assert.equal(runScript(read.run, dir, { PROFILE: '.qa' }).status, 0)
      console.log(`profile "${config}": ${readFileSync(join(dir, 'output'), 'utf8').trim()}`)
    }
    const names = ['Pull the web image for exploration', "Find the runner's docker for exploration", 'Boot the base app for the planner', 'Serve the base app to the planner', 'Tear down the explored app', 'Upload the exploration logs']
    const planIndex = planSteps.findIndex((step) => step.name === 'Plan the QA run')
    for (const name of names) {
      const step = stepOf(name)
      const text = JSON.stringify(step)
      assert.match(step.if, /steps\.explore\.outputs\.explore == 'base'/)
      assert.doesNotMatch(text, /secrets\.|GITHUB_TOKEN|GH_TOKEN|MODEL_KEY|model-key|--env-file/)
      const at = planSteps.indexOf(step)
      console.log(`plan step "${name}": runs when ${step.if}; env ${JSON.stringify(Object.keys(step.env ?? {}))}; ${at < planIndex ? 'before' : 'after'} the plan step; names no secret, token or key file`)
    }
    const boot = stepOf('Boot the base app for the planner').run
    const serve = stepOf('Serve the base app to the planner').run
    assert.match(boot, /qare explore boot --profile "\$PROFILE" --repo "\$PWD"/)
    assert.doesNotMatch(serve, /docker-access|docker\.sock|DOCKER_HOST/)
    console.log('boot step: qare explore boot, handed the runner docker; serve step: qare explore serve, handed no docker access, mounting only', serve.match(/-v "[^"]*"/g).join(' '))
    // The plan step, with docker stubbed: off, the container it ran before; on, the endpoint and the loopback.
    const plan = stepOf('Plan the QA run')
    tool('docker', 'printf "%s\\0" "$@" > "$QARE_ARGS_FILE"')
    writeFileSync(join(dir, 'change.diff'), '')
    const argsOf = (endpoint) => {
      const args = join(dir, `args-${endpoint === '' ? 'off' : 'on'}`)
      const env = { IMAGE_REF: 'image@sha256:fixture', MODEL_KEY: 'stand-in', MODEL_KEY_ENV: 'MODEL_STAND_IN', NARE_PROVIDER: '', NARE_MODEL: '', NARE_STREAM: '', NARE_BASE_URL: '', NARE_CONTEXT_WINDOW: '', QARE_MAX_OUTPUT_TOKENS: '', QARE_PLAN_BATCH_SIZE: '', QARE_PLAN_CONCURRENCY: '', PROFILE: '.qa', EXPLORE_ENDPOINT: endpoint, QARE_ARGS_FILE: args }
      const ran = runScript(plan.run, dir, env)
      assert.equal(ran.status, 0, ran.stderr)
      return readFileSync(args, 'utf8').split('\0').filter(Boolean).map((arg, at, all) => (all[at - 1] === '--env-file' ? '<key file>' : arg.replaceAll(dir, '<workspace>')))
    }
    const off = argsOf('')
    const on = argsOf(['http:', '//127.0.0.1:47001'].join(''))
    assert.ok(!off.includes('--explore') && !off.includes('--network'))
    console.log(`plan step, exploration off: docker ${off.join(' ')}`)
    console.log(`plan step, exploration on:  docker ${on.join(' ')}`)
    const network = on.indexOf('--network')
    const explore = on.indexOf('--explore')
    const added = [...on.slice(network, network + 2), ...on.slice(explore, explore + 2)]
    const rest = on.filter((_, at) => at !== network && at !== network + 1 && at !== explore && at !== explore + 1)
    assert.deepEqual(rest, off)
    assert.deepEqual(added, ['--network', 'host', '--explore', ['http:', '//127.0.0.1:47001'].join('')])
    console.log(`what exploration adds to the plan step, and all it adds: ${added.join(' ')}`)
  } else if (check === 'plan') {
    // A real exploration server beside a stand-in page, the bridge in front of it, and the planner.
    const server = await startExplorationServer(fakeApp())
    const bridge = await startExplorationBridge(server.url)
    try {
      await rpc(bridge.url, 'tools/call', { name: 'navigate', arguments: { url: '/settings' } })
      const snapped = await rpc(bridge.url, 'tools/call', { name: 'snapshot', arguments: {} })
      console.log(`the session snapshotted: ${JSON.stringify(bridge.explored())}`)
      console.log(`what it was handed: ${snapped.result.content[0].text.split('\n')[0]}`)
      const inputs = {
        criteria: CRITERIA,
        diff: 'diff --git a/settings.ts b/settings.ts',
        app: { address: ['http:', '//localhost:{{run.app_port}}'].join('') },
        exploration: { endpoint: bridge.url, tools: bridge.tools, explored: () => bridge.explored() },
      }
      const seen = { role: 'button', name: 'Save', at: SAVE_AT, page: '/settings' }
      const kept = await planRun(new FakeAgentRunner([completed(flowPlan(seen))]), inputs)
      console.log(`an element read from the explored page is kept, with its page: ${JSON.stringify(kept.criteria[0].checks[0].actions[1].element)}`)
      for (const element of [{ role: 'button', name: 'Delete', at: 'document/main/button "Delete"', page: '/settings' }, { role: 'button', name: 'Save', at: SAVE_AT, page: '/billing' }, { role: 'button', name: 'Save' }]) {
        const runner = new FakeAgentRunner([completed(flowPlan(element)), completed(flowPlan(element))])
        const refused = await planRun(runner, inputs).then(() => 'kept', (error) => `refused: ${error.message}`)
        assert.match(refused, /^refused/)
        console.log(`an element the session did not see (${JSON.stringify(element)}) is ${refused}`)
      }
      // Without exploration, the same element with no page is planned as before, and no tool is handed over.
      const { exploration: _off, ...blind } = inputs
      const runner = new FakeAgentRunner([completed(flowPlan({ role: 'button', name: 'Save' }))])
      const plain = await planRun(runner, blind)
      assert.equal(runner.requests.length, 1)
      assert.equal(runner.requests[0].tools, undefined)
      console.log(`without exploration: one turn, no tool channel, element ${JSON.stringify(plain.criteria[0].checks[0].actions[1].element)}`)
    } finally {
      await bridge.close()
      await server.close()
    }
  } else if (check === 'channel') {
    // What nare is handed: the bridge as an MCP server and only its tools.
    const server = await startExplorationServer(fakeApp())
    const bridge = await startExplorationBridge(server.url)
    try {
      const init = await rpc(bridge.url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } })
      const listed = await rpc(bridge.url, 'tools/list')
      console.log(`the bridge answers MCP ${init.result.protocolVersion} with tools ${listed.result.tools.map((tool) => tool.name).join(', ')}`)
      const off = await rpc(bridge.url, 'tools/call', { name: 'navigate', arguments: { url: ['http:', '//169.254.169.254/'].join('') } })
      console.log(`navigate off the app: isError ${off.result.isError}: ${off.result.content[0].text.split('\n')[1]}`)
      const capture = await rpc(bridge.url, 'tools/call', { name: 'capture', arguments: {} })
      console.log(`capture: isError ${capture.result.isError}`)
      // A nare stand-in that records its argv and its MCP config, run by node with no shell.
      const seenPath = join(dir, 'seen.json')
      const stand = join(dir, 'nare.mjs')
      writeFileSync(stand, `import { readFileSync, writeFileSync } from 'node:fs'\nconst argv = process.argv.slice(2)\nconst at = argv.indexOf('--mcp-config')\nwriteFileSync(${JSON.stringify(seenPath)}, JSON.stringify({ argv, config: at === -1 ? null : JSON.parse(readFileSync(argv[at + 1], 'utf8')), env: Object.keys(process.env).filter((name) => name.startsWith('QARE_EXPLORATION')) }))\nconsole.log(JSON.stringify({ type: 'result', status: 'done', questions: [], usage: { input: 1, output: 1 }, stop_reason: 'end_turn', turns: 1, contract: 3, output: {}, error: null }))\n`)
      const runner = new NareAgentRunner({ binary: process.execPath })
      const ask = (tools) => runner.run({ prompt: 'plan', system: '', toolPolicy: 'none', outputSchema: '', budget: { maxOutputTokens: 1 }, ...(tools === undefined ? {} : { tools }) })
      // node runs the stand-in script, which is the first argument nare would see.
      const original = runner.spawn.bind(runner)
      runner.spawn = (argv, ...rest) => original([stand, ...argv], ...rest)
      await ask({ allowlist: bridge.tools, endpoint: bridge.url })
      const on = JSON.parse(readFileSync(seenPath, 'utf8'))
      console.log(`with the channel, nare is handed --mcp-config ${JSON.stringify(on.config)} and --tools ${on.argv[on.argv.indexOf('--tools') + 1]}; exploration environment: ${JSON.stringify(on.env)}`)
      await ask(undefined)
      const off2 = JSON.parse(readFileSync(seenPath, 'utf8'))
      console.log(`without it: --mcp-config ${off2.argv.includes('--mcp-config') ? 'present' : 'absent'}, --tools ${off2.argv[off2.argv.indexOf('--tools') + 1]}`)
      assert.equal(off2.argv.includes('--mcp-config'), false)
      // The profile switch the pipeline reads, held by the loader.
      const app = { boot: { compose: 'compose.qa.yaml', service: 'web' }, health: { http: `${APP}/up`, timeout: '5s' }, seed: { command: 'true' }, login: { fixture: 'f.yml', role: 'admin' } }
      console.log(`profile explore: base with flavour web loads as explore=${validateProfileConfig({ app, stubs: [], visual: { widths: [], themes: [] }, suites: [], flavour: 'web', explore: 'base' }).explore}`)
      for (const extra of [{ explore: 'base' }, { flavour: 'web', explore: 'head' }]) {
        const said = (() => {
          try {
            validateProfileConfig({ app, stubs: [], visual: { widths: [], themes: [] }, suites: [], ...extra })
            return 'loaded'
          } catch (error) {
            return `refused: ${error.message}`
          }
        })()
        console.log(`profile ${JSON.stringify(extra)}: ${said}`)
      }
    } finally {
      await bridge.close()
      await server.close()
    }
  } else {
    throw new Error(`unknown check ${JSON.stringify(check)}: pipeline, plan or channel`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
