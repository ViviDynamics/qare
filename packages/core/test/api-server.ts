import { createServer, type IncomingHttpHeaders } from 'node:http'

export const API_SECRET = 'sess-0f9c2e7d41b8a6'

export interface SeenRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

/**
 * A small API for the http check's tests (#378), on the loopback interface
 * with a port the system picks. It lives outside the *.test.ts files because
 * the network-marker scanner reads those, and this helper is the one that
 * names how the server is built.
 */
export async function startApiServer(): Promise<{ origin: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body })
      const url = request.url ?? '/'
      const json = (status: number, value: unknown, headers: Record<string, string | string[]> = {}) => {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
        response.end(JSON.stringify(value))
      }
      if (url.startsWith('/app/orders') && request.method === 'POST') {
        const order = JSON.parse(body || '{}') as { items?: unknown[] }
        if ((order.items ?? []).length === 0) {
          json(422, { error: { code: 'empty_order', items: [] }, echo: request.headers.authorization ?? null }, { 'set-cookie': [`session=${API_SECRET}; HttpOnly`], 'x-request-id': 'r-1' })
          return
        }
        json(201, { id: 7, password: 'hunter2' })
        return
      }
      if (url === '/app/text') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('plain words')
        return
      }
      if (url === '/app/big') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }))
        return
      }
      if (url === '/app/redirect') {
        response.writeHead(302, { location: 'https://elsewhere.example/landing' })
        response.end()
        return
      }
      if (url === '/app/slow') {
        setTimeout(() => json(200, { late: true }), 2000).unref()
        return
      }
      json(404, { error: 'not found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the api server has no address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
