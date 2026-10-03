// The smallest SMTP client that hands one plain-text message to a relay, and
// the message the example app sends. No dependency: the app under test is a
// few files, and the catcher on the other end is the real thing.
import { connect } from 'node:net'

const SENDER = 'Mail App <no-reply@mail-app.example>'

/** The confirmation message: a link back to the app, and a one-time code. */
export function mailMessage({ to, origin, account, code }) {
  return {
    from: SENDER,
    to,
    subject: 'Confirm your account',
    text: [`Welcome. Confirm your account: ${origin}/confirm?account=${account}`, '', `Your one-time code is ${code}.`, ''].join('\r\n'),
  }
}

/** Deliver one message over SMTP. Resolves when the relay accepted it, rejects with what it answered. */
export function sendMail({ host, port }, message) {
  const envelopeFrom = /<([^>]+)>/.exec(message.from)?.[1] ?? message.from
  const content = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${new Date().toUTCString()}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    // A line that starts with a dot would end the message early.
    ...message.text.split('\r\n').map((line) => (line.startsWith('.') ? `.${line}` : line)),
    '.',
  ].join('\r\n')
  // Each step: the reply code it waits for, then what it says next.
  const steps = [
    [220, 'EHLO mail-app.example'],
    [250, `MAIL FROM:<${envelopeFrom}>`],
    [250, `RCPT TO:<${message.to}>`],
    [250, 'DATA'],
    [354, content],
    [250, 'QUIT'],
  ]
  return new Promise((resolve, reject) => {
    const socket = connect(port, host)
    let buffered = ''
    let done = false
    socket.setEncoding('utf8')
    socket.setTimeout(10_000, () => socket.destroy(new Error('the relay did not answer in 10s')))
    socket.on('data', (chunk) => {
      buffered += chunk
      // A reply may span lines; its last line has a space after the code.
      const lines = buffered.split('\r\n').filter((line) => line !== '')
      const last = lines.at(-1)
      if (!buffered.endsWith('\r\n') || last === undefined || !/^\d{3} /.test(last)) return
      buffered = ''
      const step = steps.shift()
      if (step === undefined) return
      const [expected, next] = step
      if (Number(last.slice(0, 3)) !== expected) {
        socket.destroy(new Error(`the relay answered ${JSON.stringify(last)} where ${expected} was expected`))
        return
      }
      if (steps.length === 0) done = true
      socket.write(`${next}\r\n`)
    })
    socket.on('error', reject)
    socket.on('close', () => (done ? resolve() : reject(new Error('the relay closed the connection before the message was accepted'))))
  })
}
