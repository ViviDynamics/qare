// An app that sends mail: signing up delivers a confirmation message over
// SMTP to the relay the stack provides, and the link in it confirms the
// account. The stack publishes one port, the one the run minted, so the
// catcher's web interface is served under /mailpit on that same port.
import { createServer, request } from 'node:http'
import { mailMessage, sendMail } from './smtp.mjs'

const RELAY = { host: process.env.MAIL_HOST ?? 'mailpit', port: 1025 }
const CATCHER = { host: RELAY.host, port: 8025 }
const ADDRESS = /^[^\s<>@"\\]+@[^\s<>@"\\]+$/

let accounts = 0
const pending = new Set()

function answer(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`${text}\n`)
}

/** Hand a request to the catcher as it came, and its answer back. */
function toCatcher(req, res, path = req.url) {
  const upstream = request(
    { host: CATCHER.host, port: CATCHER.port, path, method: req.method, headers: { ...req.headers, host: `${CATCHER.host}:${CATCHER.port}` } },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    },
  )
  upstream.on('error', () => answer(res, 502, 'the mail catcher is not reachable'))
  req.pipe(upstream)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname === '/mailpit' || url.pathname.startsWith('/mailpit/')) return toCatcher(req, res)
  // Up means the app can send: the relay it depends on is ready too.
  if (url.pathname === '/up') return toCatcher(req, res, '/mailpit/readyz')
  if (url.pathname === '/signup') {
    const email = url.searchParams.get('email') ?? ''
    if (!ADDRESS.test(email)) return answer(res, 400, 'email is not an address')
    accounts += 1
    const account = accounts
    pending.add(account)
    const code = String(100000 + Math.floor(Math.random() * 900000))
    sendMail(RELAY, mailMessage({ to: email, origin: `http://${req.headers.host}`, account, code })).then(
      () => answer(res, 200, 'sent'),
      (error) => answer(res, 502, `the confirmation message was not sent: ${error.message}`),
    )
    return
  }
  if (url.pathname === '/confirm') {
    const account = Number(url.searchParams.get('account'))
    if (!pending.delete(account)) return answer(res, 404, 'no such account is waiting to be confirmed')
    return answer(res, 200, `confirmed account ${account}`)
  }
  answer(res, 404, 'not found')
})

server.listen(3000)
// A container is stopped with SIGTERM; node as PID 1 ignores it unless asked.
process.on('SIGTERM', () => server.close(() => process.exit(0)))
