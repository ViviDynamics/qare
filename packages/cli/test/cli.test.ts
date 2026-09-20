import { expect, test } from 'vitest'
import { VERSION } from '@qare/core'
import { main } from '../src/index.js'

test('--version prints the core version', () => {
  const lines: string[] = []
  const code = main(['--version'], { write: (chunk) => lines.push(chunk) })
  expect(code).toBe(0)
  expect(lines.join('')).toBe(`${VERSION}\n`)
})

test('no arguments prints usage', () => {
  const lines: string[] = []
  const code = main([], { write: (chunk) => lines.push(chunk) })
  expect(code).toBe(0)
  expect(lines.join('')).toContain('usage: qare --version')
})
