// Hold a failing run's evidence to what #78 asks of it: a recording, a log
// excerpt and a tree snapshot, none of which contains the planted secret.
//
//   node examples/electron-app/check-evidence.mjs <evidence dir> <check dir> <secret> <log label>
//
// <evidence dir> is one run's evidence, <check dir> the failing check's
// directory inside it, and <log label> what the driver calls the page in its
// platform log (`page 1` in the browser, `window 1` in a desktop build).
//
// It reads the evidence with qare's own readers, from the image the run
// executed in (QARE_CORE names another build of them), and exits non-zero
// naming the first thing that is not as it should be.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const { decodePng, splitApng } = await import(process.env.QARE_CORE ?? '/opt/qare/lib/packages/core/dist/index.js')

const [evidenceDir, checkDir, secret, label] = process.argv.slice(2)
if (evidenceDir === undefined || checkDir === undefined || secret === undefined || label === undefined) {
  console.error('usage: node check-evidence.mjs <evidence dir> <check dir> <secret> <log label>')
  process.exit(4)
}
const fail = (message) => {
  console.error(`${evidenceDir}: ${message}`)
  process.exit(1)
}
const dir = join(evidenceDir, checkDir)

/** The widest run of pure black in one row: text never makes a wide one, a blacked-out field does. */
function widestBlackRun(png) {
  const image = decodePng(png)
  let widest = 0
  for (let y = 0; y < image.height; y += 1) {
    let run = 0
    for (let x = 0; x < image.width; x += 1) {
      const at = (y * image.width + x) * 4
      if (image.pixels[at] === 0 && image.pixels[at + 1] === 0 && image.pixels[at + 2] === 0) {
        run += 1
        if (run > widest) widest = run
      } else run = 0
    }
  }
  return widest
}
/** A field is some hundred pixels wide; the widest stroke of a letter is a few. */
const CONCEALED = 100

// The recording: an animated PNG of several frames. The flow's first frames
// were taken before the secret was typed and conceal nothing; its last ones
// black out the field the secret went into, and so does the failure
// screenshot.
const frames = splitApng(await readFile(join(dir, 'recording.png')))
if (frames.length < 3) fail(`the recording holds ${frames.length} frames, which is not a flow`)
const runs = frames.map((frame) => widestBlackRun(frame.png))
if (runs[0] >= CONCEALED) fail(`the recording's first frame conceals something before any secret was typed (a black run of ${runs[0]} pixels)`)
if (runs.at(-1) < CONCEALED) fail(`the recording's last frame does not black out the field the secret was typed into (its widest black run is ${runs.at(-1)} pixels)`)
// Once concealed, always concealed: no frame after the first concealed one shows the field again.
const from = runs.findIndex((run) => run >= CONCEALED)
const shown = runs.findIndex((run, index) => index > from && run < CONCEALED)
if (shown !== -1) fail(`frame ${shown} of the recording shows the field again after it was concealed in frame ${from}`)
const failure = widestBlackRun(await readFile(join(dir, 'failure.png')))
if (failure < CONCEALED) fail(`the failure screenshot does not black out the field the secret was typed into (its widest black run is ${failure} pixels)`)

// The log excerpt: what the platform wrote up to the failure, the secret swept from it.
const excerpt = await readFile(join(dir, 'failure.log'), 'utf8')
if (!excerpt.startsWith('the platform log from 30 s before the check stopped to its end')) fail('failure.log does not say which window of the log it is')
if (!excerpt.includes('\n--- the check stopped here ---\n')) fail('failure.log does not mark where the check stopped')
const logged = new RegExp(`^\\[-\\d+\\.\\d{3}s\\] \\[${label} console\\.log\\] renderer: access code \\[redacted\\]$`, 'm')
if (!logged.test(excerpt)) fail(`failure.log does not hold the line the application logged the access code on, swept, under ${label}`)
const whole = await readFile(join(dir, 'console.log'), 'utf8')
if (!whole.includes(`[${label} console.log] renderer: access code [redacted]`)) fail('console.log does not hold the same line, swept')

// The tree snapshot at the failed assertion: the field is in it, and its value is not.
const actions = await readFile(join(dir, 'actions.log'), 'utf8')
const snapshotName = /^snapshot (assert-\d+\.json): /m.exec(actions)?.[1]
if (snapshotName === undefined) fail('the action log names no snapshot at the assertion')
const snapshot = JSON.parse(await readFile(join(dir, snapshotName), 'utf8'))
const nodes = []
const walk = (node) => {
  nodes.push(node)
  for (const child of node.children ?? []) walk(child)
}
walk(snapshot.snapshot)
const field = nodes.find((node) => node.role === 'textbox' && node.name === 'Access code')
if (field === undefined) fail(`${snapshotName} does not hold the access code field the harness saw`)
// A tree that carries the field's value carries it swept; one that carries none has nothing to sweep.
if (field.value !== undefined && field.value !== '[redacted]') fail(`${snapshotName} holds the access code field with a value that was not swept: ${JSON.stringify(field.value)}`)
if (!actions.includes('role=textbox name=Access code is concealed in every capture from here on')) fail('the action log does not say the field was concealed')
if (!/^recording recording\.png: \d+ frames over /m.test(actions)) fail('the action log does not describe the recording')

// The sweep: no byte of the secret in any file of the run's evidence, images included.
const files = []
const list = async (at) => {
  for (const entry of await readdir(at, { withFileTypes: true })) {
    if (entry.isDirectory()) await list(join(at, entry.name))
    else files.push(join(at, entry.name))
  }
}
await list(evidenceDir)
for (const file of files) if ((await readFile(file)).includes(secret)) fail(`${file} contains the planted secret`)

const bytes = (await readFile(join(dir, 'recording.png'))).length
console.log(`${evidenceDir}: a recording of ${frames.length} frames (${bytes} bytes), a log excerpt and ${snapshotName}; the planted secret is in none of the ${files.length} files, and its field is blacked out from frame ${from} on`)
