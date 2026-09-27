import { expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

test('doctor reports a ready host in json and exits clean', async () => {
  const { lines, writer } = capture()
  const code = await main(['doctor', '--json', '--nare', process.execPath], writer)
  expect(code).toBe(0)
  const report = JSON.parse(lines.join(''))
  expect(report.ready).toBe(true)
  expect(report.execution).toBeDefined()
  expect(report.findings.some((finding) => finding.name === 'nare' && finding.ok)).toBe(true)
  expect(report.findings.some((finding) => finding.name === 'node' && finding.ok)).toBe(true)
})

test('doctor names a missing nare, says how to install it, and exits 1', async () => {
  const { lines, writer } = capture()
  const code = await main(['doctor', '--nare', '/nonexistent/qare-nare'], writer)
  expect(code).toBe(1)
  const text = lines.join('')
  expect(text).toContain('missing nare')
  expect(text).toContain('install the pinned nare beside qare')
  expect(text).not.toContain('undefined')
})

test('doctor refuses an unknown flag', async () => {
  const code = await main(['doctor', '--wat'], { write: () => {} })
  expect(code).toBe(4)
})
