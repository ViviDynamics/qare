// The desktop shell of the example (#72): one window that loads the same
// renderer the browser half is served, with no preload and no node access in
// the page. What it writes here is the application's own console output,
// which the Electron driver publishes as evidence.
import { app, BrowserWindow, net, session } from 'electron'
import http from 'node:http'
import https from 'node:https'
import { connect } from 'node:net'
import path from 'node:path'

// What the main process reaches for when it starts (#223): every
// `--probe=<url>` the build is launched with is requested twice from here,
// once through Node and once through Chromium's network stack, and never
// from a page. No window sees either request, which is why a run cannot
// watch a desktop build's traffic from its windows and contains the whole
// process instead. Each line says how the request ended.
const probes = process.argv.filter((arg) => arg.startsWith('--probe=')).map((arg) => arg.slice('--probe='.length))

// `--probe=unix:<path>` connects to a unix socket instead: a way out that is
// not a network at all, which a process outside the build could leave in
// the build's own directory.
function probeSocket(path) {
  return new Promise((resolve) => {
    const socket = connect(path)
    socket.on('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.on('error', (error) => resolve(`error ${error.code ?? error.message}`))
  })
}

function probeWithNode(url) {
  return new Promise((resolve) => {
    const request = (url.startsWith('https:') ? https : http).get(url, { timeout: 10_000 }, (response) => {
      response.resume()
      resolve(`status ${response.statusCode}`)
    })
    request.on('timeout', () => request.destroy(new Error('timed out')))
    request.on('error', (error) => resolve(`error ${error.code ?? error.message}`))
  })
}

async function probeWithChromium(url) {
  try {
    const response = await net.fetch(url, { signal: AbortSignal.timeout(10_000) })
    return `status ${response.status}`
  } catch (error) {
    return `error ${error.message}`
  }
}

app.whenReady().then(async () => {
  console.log(`main: ready, user data at ${app.getPath('userData')}`)
  // The spellchecker is given no language: with one, the runtime downloads
  // its dictionary from redirector.gvt1.com as soon as it starts, a host this
  // application never asked for and no profile here declares (#223).
  session.defaultSession.setSpellCheckerLanguages([])
  // Before any window opens, so a run that drives the windows has the whole
  // of what the main process reached for behind it.
  for (const url of probes) {
    if (url.startsWith('unix:')) {
      console.log(`main: probe socket ${url.slice('unix:'.length)} -> ${await probeSocket(url.slice('unix:'.length))}`)
      continue
    }
    console.log(`main: probe node ${url} -> ${await probeWithNode(url)}`)
    console.log(`main: probe chromium ${url} -> ${await probeWithChromium(url)}`)
  }
  if (probes.length > 0) console.log('main: probes done')
  const window = new BrowserWindow({ width: 900, height: 640, webPreferences: { contextIsolation: true, sandbox: true } })
  // A window the page opens is a window of the application: the details view
  // opens in one of its own, which is what the multi-window flow drives.
  window.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { width: 480, height: 360 } }))
  void window.loadFile(path.join(import.meta.dirname, 'renderer', 'index.html'))
})

app.on('window-all-closed', () => {
  console.error('main: every window closed, quitting')
  app.quit()
})
