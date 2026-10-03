// The desktop shell of the example (#72): one window that loads the same
// renderer the browser half is served, with no preload and no node access in
// the page. What it writes here is the application's own console output,
// which the Electron driver publishes as evidence.
import { app, BrowserWindow } from 'electron'
import path from 'node:path'

app.whenReady().then(() => {
  console.log(`main: ready, user data at ${app.getPath('userData')}`)
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
