#!/usr/bin/env node
// Serialize draft criteria into the ledger's export form, so a draft can be
// validated through qare's own strict loader instead of by eye.
// usage: validate.mjs <entries.json> <export-dir>
//   entries.json  a JSON array of ledger entries
//   export-dir    an empty directory to write the export into
// The repo must be built first: the serializer lives in packages/core/dist.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [entriesPath, outDir] = process.argv.slice(2)
if (!entriesPath || !outDir) {
  console.error('usage: validate.mjs <entries.json> <export-dir>')
  process.exit(2)
}

// Resolve the workspace's own built core from the repo root, wherever the
// script is run from.
const core = await import(
  pathToFileURL(join(process.cwd(), 'packages', 'core', 'dist', 'index.js')).href
)
const entries = JSON.parse(await readFile(entriesPath, 'utf8'))
const text = core.serializeLedgerDocument(entries, [])
core.parseLedgerDocument(JSON.parse(text))
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'ledger.json'), text)
console.log(`serialized ${entries.length} entries into ${outDir}`)
