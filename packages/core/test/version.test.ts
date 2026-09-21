import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { VERSION } from '../src/index.js'

const CALVER = /^20\d{2}\.\d+\.\d+$/

test('version is CalVer (YYYY.M.PATCH)', () => {
  expect(VERSION).toMatch(CALVER)
})

test('version matches the root package.json (single source of truth)', () => {
  const root = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
  )
  expect(VERSION).toBe(root.version)
})
