#!/usr/bin/env node
// Stamps the image's own record: the pinned versions the image ships, written
// where a run reads them into its evidence (/opt/qare/config/IMAGE.json).
// A run inside the image can therefore name what produced it without asking
// the registry.
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const name = process.argv[2]
if (name === undefined) {
  console.error('usage: node image-info.mjs <image-name>')
  process.exit(64)
}

const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const nare = execFileSync('python3', ['-m', 'pip', 'show', 'nare']).toString()
  .split('\n')
  .find((line) => line.startsWith('Version:'))
  ?.slice('Version: '.length) ?? ''

process.stdout.write(
  `${JSON.stringify({
    name,
    flavour: 'core',
    qare: pkg.version,
    nare,
    node: process.versions.node,
    drivers: {},
  }, null, 2)}\n`,
)
