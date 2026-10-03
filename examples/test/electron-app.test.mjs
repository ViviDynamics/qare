// The example that drives a desktop build (#72), held together without an
// Electron runtime or a display: its two profiles load, its one plan loads
// against the driver each profile names, and the files the two targets show
// are the same files. Launching the build is CI's electron-driver job
// (scripts/electron-driver.sh), which needs the runtime this suite must not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BROWSER_FLOW_DRIVER, ELECTRON_FLOW_DRIVER, flowDriverFor, loadPlan, loadProfile } from '../../packages/core/dist/index.js'

const example = fileURLToPath(new URL('../electron-app/', import.meta.url))

test('the two profiles differ in the target and in nothing else a flow can see', async () => {
  const desktop = await loadProfile(join(example, 'profiles', 'desktop'))
  const web = await loadProfile(join(example, 'profiles', 'web'))

  // The desktop build is launched by the run: no stack, no URL.
  assert.deepEqual(desktop.client, { driver: 'electron', executable: 'examples/electron-app/dist/qare-example/qare-example', args: ['--no-sandbox'] })
  assert.equal(desktop.app, undefined)
  assert.equal(desktop.target, undefined)
  assert.equal(web.client, undefined)
  assert.match(web.target.url, /127\.0\.0\.1:4173$/)

  assert.equal(flowDriverFor(desktop), ELECTRON_FLOW_DRIVER)
  assert.equal(flowDriverFor(web), BROWSER_FLOW_DRIVER)
  // Both run in the image that ships the browser and the virtual display.
  assert.equal(desktop.flavour, 'web')
  assert.equal(web.flavour, 'web')
})

test('one plan loads against the browser and against the desktop build, unedited', async () => {
  const text = await readFile(join(example, 'plan.json'), 'utf8')
  const forBrowser = loadPlan(text, [], BROWSER_FLOW_DRIVER)
  const forDesktop = loadPlan(text, [], ELECTRON_FLOW_DRIVER)
  assert.deepEqual(forDesktop, forBrowser)

  const actions = forDesktop.criteria.flatMap((criterion) => criterion.checks).flatMap((check) => check.actions)
  // Every action a person takes on a page: the vocabulary both drivers declare.
  assert.deepEqual(
    actions.map((action) => action.action),
    ['open', 'waitFor', 'type', 'choose', 'click', 'assertText', 'assertElement', 'capture'],
  )
  // A page is opened by path, which is what lets the target change under it.
  for (const action of actions.filter((entry) => entry.action === 'open')) assert.match(action.url, /^\//)
  // Elements are named by role and accessible name, never by a selector.
  for (const action of actions.filter((entry) => entry.element !== undefined)) assert.deepEqual(Object.keys(action.element).sort(), ['name', 'role'])
})

test('the multi-window plan uses the same vocabulary: no action names a window', async () => {
  const plan = loadPlan(await readFile(join(example, 'plan-windows.json'), 'utf8'), [], ELECTRON_FLOW_DRIVER)
  const actions = plan.criteria.flatMap((criterion) => criterion.checks).flatMap((check) => check.actions)
  for (const action of actions) assert.ok(ELECTRON_FLOW_DRIVER.actions.includes(action.action), action.action)
  // It reaches into the window the application opens, and back out of it.
  const clicked = actions.filter((action) => action.action === 'click').map((action) => action.element.name)
  assert.deepEqual(clicked, ['Open details', 'Close details'])
})

test('a plan the desktop driver cannot run is refused when it loads, naming the driver', async () => {
  const visual = JSON.stringify({
    schemaVersion: '1',
    criteria: [{ id: 'looks', text: 'the greeter looks right', checks: [{ kind: 'visual', name: 'home', screenshot: 'home', url: '/' }] }],
  })
  assert.throws(() => loadPlan(visual, [], ELECTRON_FLOW_DRIVER), /a visual check is not one the electron driver declares/)
  assert.doesNotThrow(() => loadPlan(visual, [], BROWSER_FLOW_DRIVER))
})

test('the desktop build bundles the files the browser is served, and its runtime is pinned', async () => {
  // One renderer directory: the server serves it and the packager copies the
  // application directory that holds it.
  const serve = await readFile(join(example, 'serve.mjs'), 'utf8')
  assert.match(serve, /new URL\('\.\/app\/renderer\/', import\.meta\.url\)/)
  const packager = await readFile(join(example, 'package.mjs'), 'utf8')
  assert.match(packager, /cp\(join\(here, 'app'\), join\(out, 'resources', 'app'\)/)
  const main = await readFile(join(example, 'app', 'main.js'), 'utf8')
  assert.match(main, /loadFile\(path\.join\(import\.meta\.dirname, 'renderer', 'index\.html'\)\)/)

  // An exact version, held by a lockfile of the example's own: the workspace
  // gains no dependency, and the runtime is not a moving one.
  const manifest = JSON.parse(await readFile(join(example, 'package.json'), 'utf8'))
  assert.match(manifest.devDependencies.electron, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(Object.keys(manifest.devDependencies), ['electron'])
  const lock = await readFile(join(example, 'pnpm-lock.yaml'), 'utf8')
  assert.ok(lock.includes(`electron@${manifest.devDependencies.electron}`))
  const workspace = JSON.parse(await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
  assert.equal(workspace.devDependencies.electron, undefined)
})
