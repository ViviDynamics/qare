import { expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

test('reap downs every qare project compose is running and none of the others', async () => {
  const downs: string[] = []
  const out = capture()
  const err = capture()

  const code = await main(['reap'], out.writer, err.writer, {
    runCompose: async (args) => {
      if (args[0] === 'ls')
        return { code: 0, stdout: JSON.stringify([{ Name: 'qare-abc' }, { name: 'qare-def' }, { Name: 'someone-elses' }]), stderr: '' }
      downs.push(args[1] ?? '')
      return { code: 0, stdout: '', stderr: '' }
    },
  })

  expect(code).toBe(0)
  expect(downs).toEqual(['qare-abc', 'qare-def'])
  expect(out.lines.join('')).toContain('reaped 2 qare projects, 0 failures')
  expect(err.lines).toEqual([])
})

test('reap names a project compose could not down and fails the command', async () => {
  const downs: string[] = []
  const out = capture()
  const err = capture()

  const code = await main(['reap'], out.writer, err.writer, {
    runCompose: async (args) => {
      if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify([{ Name: 'qare-stuck' }, { Name: 'qare-gone' }]), stderr: '' }
      downs.push(args[1] ?? '')
      return args[1] === 'qare-stuck' ? { code: 1, stdout: '', stderr: 'compose boom' } : { code: 0, stdout: '', stderr: '' }
    },
  })

  expect(code).toBe(4)
  expect(downs).toEqual(['qare-stuck', 'qare-gone'])
  expect(err.lines.join('')).toContain('could not reap qare-stuck: compose boom')
  expect(out.lines.join('')).toContain('reaped 1 qare projects, 1 failures')
})

test('reap fails closed when compose ls does not answer with a project list', async () => {
  const err = capture()

  const code = await main(['reap'], capture().writer, err.writer, {
    runCompose: async () => ({ code: 1, stdout: '', stderr: 'docker daemon down' }),
  })

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('cannot tell which projects are its leftovers')
})

test('reap parses the listing from stdout alone, so a warning on stderr does not break the sweep', async () => {
  const downs: string[] = []
  const out = capture()
  const err = capture()

  const code = await main(['reap'], out.writer, err.writer, {
    runCompose: async (args) => {
      if (args[0] === 'ls')
        return {
          code: 0,
          stdout: JSON.stringify([{ Name: 'qare-ok' }]),
          stderr: 'time="2026-09-27T00:00:00Z" level=warning msg="a warning"',
        }
      downs.push(args[1] ?? '')
      return { code: 0, stdout: '', stderr: '' }
    },
  })

  expect(code).toBe(0)
  expect(downs).toEqual(['qare-ok'])
  expect(out.lines.join('')).toContain('reaped 1 qare projects, 0 failures')
})

test('reap fails closed when compose ls exits non-zero, even when its stdout parses as empty', async () => {
  const err = capture()

  const code = await main(['reap'], capture().writer, err.writer, {
    runCompose: async () => ({ code: 3, stdout: '[]', stderr: '' }),
  })

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('compose ls exited 3')
})

test('reap downs exactly the named projects and refuses to touch a project that is not qare-owned (#53)', async () => {
  const downs: string[] = []
  const listings: string[] = []
  const out = capture()
  const err = capture()

  const code = await main(['reap', 'qare-dead', 'production'], out.writer, err.writer, {
    runCompose: async (args) => {
      if (args[0] === 'ls') {
        listings.push(args.join(' '))
        return { code: 0, stdout: JSON.stringify([]), stderr: '' }
      }
      downs.push(args[1] ?? '')
      return { code: 0, stdout: '', stderr: '' }
    },
  })

  expect(code).toBe(4)
  // The named project is downed without a listing: the caller named it from
  // the evidence, and a live queue's other projects are never touched.
  expect(downs).toEqual(['qare-dead'])
  expect(listings).toEqual([])
  expect(err.lines.join('')).toContain('could not reap production: not a qare project')
  expect(out.lines.join('')).toContain('reaped 1 qare projects, 1 failures')
})

test('reap bounds every compose call, so a hung docker daemon cannot hold the cleanup queue forever (#53)', async () => {
  const deadlines: number[] = []
  const out = capture()
  const err = capture()

  const code = await main(['reap'], out.writer, err.writer, {
    runCompose: async (args, timeoutMs) => {
      deadlines.push(timeoutMs)
      if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify([{ Name: 'qare-hung' }, { Name: 'qare-fine' }]), stderr: '' }
      // A call the deadline killed resolves with a non-zero code and no output.
      return args[1] === 'qare-hung' ? { code: -1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    },
  })

  expect(code).toBe(4)
  // The ls call and every down are bounded: no deadline of 0 anywhere.
  expect(deadlines.every((timeoutMs) => timeoutMs > 0)).toBe(true)
  // A timeout is that project's failure: the sweep continued to qare-fine.
  expect(err.lines.join('')).toContain('could not reap qare-hung: compose down exited -1')
  expect(out.lines.join('')).toContain('reaped 1 qare projects, 1 failures')
})
