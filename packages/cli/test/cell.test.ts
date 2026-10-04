import { expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

test('qare cell is the run\'s own command, and a call it does not understand says what it takes (#223)', async () => {
  const err = capture()
  expect(await main(['cell'], capture().writer, err.writer)).toBe(4)
  expect(await main(['cell', 'gate'], capture().writer, err.writer)).toBe(4)
  expect(err.lines).toEqual([
    'usage: qare cell gate --socket-dir <dir> [--host <name>]... [--port <port> <scheme>] [--map <host>=<name>]... [--app <host>:<port>[:<dial-port>]] | qare cell launch --socket-dir <dir> --cdp-port <port> [--no-display] -- <command> [args...]\n',
    'qare cell gate: --socket-dir is required\n',
  ])
})
