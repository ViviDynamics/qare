import { expect, test } from 'vitest'
import { VERSION } from '../src/index.js'

test('version is the CalVer placeholder', () => {
  expect(VERSION).toBe('0.0.0-dev')
})
