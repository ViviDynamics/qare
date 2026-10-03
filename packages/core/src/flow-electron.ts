import type { FlowDriverCapabilities } from './flow.js'

/**
 * The Electron driver's own declaration (#72). A desktop shell is a browser
 * in a window, so it declares the browser's whole vocabulary and a flow moves
 * across with no edit beyond the target. Its evidence is the browser's, plus
 * the application's own console output. What it cannot do is declared rather
 * than found out: it serves no `visual` and no `a11y` check, because both
 * resize and re-theme a viewport, and a desktop window is not one.
 */
export const ELECTRON_FLOW_DRIVER: FlowDriverCapabilities = {
  name: 'electron',
  actions: ['open', 'type', 'click', 'choose', 'waitFor', 'assertText', 'assertElement', 'capture', 'totp', 'backupCode'],
  evidence: ['screenshot', 'trace', 'console'],
  checks: [],
}
