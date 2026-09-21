import { pathToFileURL } from 'node:url'
import { VERSION } from '@qare/core'

export interface Writer {
  write(chunk: string): void
}

export function entry(out: Writer = process.stdout): void {
  out.write(`@qare/action ${VERSION}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  entry()
}
