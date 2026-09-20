import { expect, test } from 'vitest'
import { VERSION } from '@qare/core'
import { entry } from '../src/index.js'

test('entry prints the package name and core version', () => {
  const lines: string[] = []
  entry({ write: (chunk) => lines.push(chunk) })
  expect(lines.join('')).toBe(`@qare/mcp ${VERSION}\n`)
})
