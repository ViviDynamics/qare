// Serve the example's renderer over HTTP (#72): the browser half of the proof
// that one flow runs against both targets. The files are the ones the desktop
// build bundles, so the two targets differ in nothing but how they are
// reached.
//
//   node examples/electron-app/serve.mjs [port]
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./app/renderer/', import.meta.url))
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  const file = normalize(join(root, path === '/' ? 'index.html' : path))
  if (!file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return response.writeHead(403).end('forbidden')
  try {
    const body = await readFile(file)
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body)
  } catch {
    response.writeHead(404).end('not found')
  }
})

const port = Number(process.argv[2] ?? 4173)
server.listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`))
