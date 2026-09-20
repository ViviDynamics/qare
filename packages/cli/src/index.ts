#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { VERSION } from '@qare/core'

export interface Writer {
  write(chunk: string): void
}

export function main(argv: string[], out: Writer = process.stdout): number {
  if (argv.includes('--version') || argv.includes('-v')) {
    out.write(`${VERSION}\n`)
    return 0
  }
  out.write(`qare ${VERSION}\nusage: qare --version\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
