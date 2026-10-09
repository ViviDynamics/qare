import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { join } from 'node:path'

/** Loopback-only fake, like action/test/fake-github.ts; no external service is contacted. */
export async function fakeCluster(dir: string): Promise<{ port: number; headers: Array<string | undefined>; close: () => Promise<void> }> {
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { encoding: 'utf8' })
  if (generated.status !== 0) throw new Error(`could not make loopback TLS fixture: ${generated.stderr}`)
  const headers: Array<string | undefined> = []
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
    headers.push(request.headers.authorization)
    response.writeHead(403)
    response.end()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '::', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing fake cluster address')
  return { port: address.port, headers, close: () => new Promise(resolve => server.close(() => resolve())) }
}
