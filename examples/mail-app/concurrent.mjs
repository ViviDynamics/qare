// Two waits at once on one real catcher (#65): each mints its own address,
// each is sent its own message while the other waits, and each must read its
// own and nothing else. Afterwards both delete what they were sent, and the
// catcher must hold only the message of a bystander neither of them minted.
//
//   node examples/mail-app/concurrent.mjs <catcher url> <relay host:port>
//
// Exits 0 when all of that held, 1 with the reasons when it did not.
import { mailReader, mailpitSource, mintRunValues, runMailCheck } from '../../packages/core/dist/index.js'
import { mailMessage, sendMail } from './smtp.mjs'

const [url, relayAt] = process.argv.slice(2)
if (url === undefined || relayAt === undefined) {
  console.error('usage: node examples/mail-app/concurrent.mjs <catcher url> <relay host:port>')
  process.exit(4)
}
const relay = { host: relayAt.slice(0, relayAt.lastIndexOf(':')), port: Number(relayAt.slice(relayAt.lastIndexOf(':') + 1)) }
const source = mailpitSource(url)
const origin = 'http://localhost:3000'
const bystander = 'qare-bystander@localhost'

await sendMail(relay, mailMessage({ to: bystander, origin, account: 0, code: '000000' }))

const runs = [1, 2].map((account) => ({ account, address: mintRunValues().mail_address }))
const faults = []
const report = await Promise.all(
  runs.map(async (run) => {
    // The wait starts first: only what arrives after it began counts.
    const wait = runMailCheck({ address: run.address, subject: 'Confirm your account' }, source.describe, mailReader(source), 30_000)
    await sendMail(relay, mailMessage({ to: run.address, origin, account: run.account, code: String(111111 * run.account) }))
    const outcome = await wait
    if (outcome.status !== 'passed') {
      faults.push(`run ${run.account} read no message: ${outcome.reason}`)
      return { run: run.account, status: outcome.status }
    }
    if (!outcome.message.body.includes(`account=${run.account}`)) faults.push(`run ${run.account} read a message that was not its own`)
    const listed = await source.list({ address: run.address })
    if (listed.length !== 1) faults.push(`run ${run.account} sees ${listed.length} messages at its address, not 1`)
    return { run: run.account, status: outcome.status, wait_ms: outcome.waitMs, polls: outcome.polls }
  }),
)

for (const run of runs) {
  const deleted = await source.delete({ address: run.address })
  if (deleted !== 1) faults.push(`run ${run.account} deleted ${deleted} messages, not 1`)
  const left = await source.list({ address: run.address })
  if (left.length !== 0) faults.push(`run ${run.account} left ${left.length} messages behind`)
}
const others = await source.list({ address: bystander })
if (others.length !== 1) faults.push(`the bystander's message did not survive the cleanup (${others.length} left)`)

console.log(JSON.stringify({ source: source.describe, runs: report, bystander_left: others.length, faults }, null, 2))
process.exit(faults.length === 0 ? 0 : 1)
