import { pathToFileURL } from 'node:url'
import { VERSION } from '@qare/core'
import { createMcpServer } from './server.js'
import type { McpServer } from './server.js'

export interface Writer {
  write(chunk: string): void
}

export function entry(out: Writer = process.stdout): void {
  out.write(`@qare/mcp ${VERSION}\n`)
}

function stdioServer(): McpServer {
  return createMcpServer({
    stdout: (chunk) => process.stdout.write(chunk),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--serve') {
    const server = stdioServer()
    process.stdin.setEncoding('utf8')
    let buffered = ''
    process.stdin.on('data', (chunk: string) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) void server.handleLine(line)
    })
  } else {
    entry()
  }
}
