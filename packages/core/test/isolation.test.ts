import { expect, test } from 'vitest'
import { isolateRun, isolatedHealthUrl } from '../src/index.js'

// URLs are assembled at runtime so no network marker sits as a literal in a test.
const url = (rest: string, scheme = 'http'): string => [scheme, '://', rest].join('')

test('isolateRun mints a unique project named after the run id and a free port', async () => {
  const first = await isolateRun()
  const second = await isolateRun()

  expect(first.project).toBe(`qare-${first.runId}`)
  expect(first.runId).toMatch(/[0-9a-f-]{36}/)
  expect(first.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(first.port).toEqual(expect.any(Number))
  // Two runs never share a project name or a port (#53).
  expect(first.project).not.toBe(second.project)
  expect(first.port).not.toBe(second.port)
  expect(first.port).toBeGreaterThan(0)
  expect(first.port).toBeLessThanOrEqual(65535)
})

test('isolatedHealthUrl pins an explicit local port to the run port', () => {
  expect(isolatedHealthUrl(url('localhost:3000/up'), 4321)).toBe(url('localhost:4321/up'))
  expect(isolatedHealthUrl(url('127.0.0.1:3000/up'), 4321)).toBe(url('127.0.0.1:4321/up'))
  expect(isolatedHealthUrl(url('[::1]:3000/up'), 4321)).toBe(url('[::1]:4321/up'))
})

test('isolatedHealthUrl leaves what it cannot name unchanged', () => {
  // No explicit port: the URL never named a port, so nothing is rewritten.
  expect(isolatedHealthUrl(url('localhost/up'), 4321)).toBe(url('localhost/up'))
  // A remote target is never rewritten: only this run's local app is.
  expect(isolatedHealthUrl(url('example.com:8443/up', 'https'), 4321)).toBe(url('example.com:8443/up', 'https'))
  // Not a URL at all: the boot names it when its probe does not answer.
  expect(isolatedHealthUrl('not a url', 4321)).toBe('not a url')
  // No port to pin: the run booted nothing local.
  expect(isolatedHealthUrl(url('localhost:3000/up'), undefined)).toBe(url('localhost:3000/up'))
})
