import { createSocket } from 'node:dgram'
import { connect, createServer, type AddressInfo } from 'node:net'

// Real sockets for the egress sink and relay tests (#382), on the machine's
// own loopback only. Kept out of the test file, as cell-sockets.ts is, so
// the offline scanner holds every *.test.ts to reaching nothing.

export interface Answer {
  id: number
  rcode: number
  addresses: string[]
}

export interface Closable {
  close: () => Promise<void>
}

/** Send one DNS query to a sink on the loopback, and read the reply's rcode and A records. */
export function ask(port: number, message: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('no answer'))
    }, 2000)
    socket.on('message', (reply) => {
      clearTimeout(timer)
      socket.close()
      const count = reply.readUInt16BE(6)
      // Skip the question: the name, then type and class.
      let at = 12
      while (reply[at] !== 0) at += (reply[at] as number) + 1
      at += 5
      const addresses: string[] = []
      for (let index = 0; index < count; index += 1) {
        at += 2 // a pointer to the question's name
        const length = reply.readUInt16BE(at + 8)
        addresses.push([...reply.subarray(at + 10, at + 10 + length)].join('.'))
        at += 10 + length
      }
      resolve({ id: reply.readUInt16BE(0), rcode: (reply[3] as number) & 0x0f, addresses })
    })
    socket.send(message, port, '127.0.0.1')
  })
}

/** A server on the loopback that answers every connection with the text and closes it. */
export async function echoServer(text: string): Promise<Closable & { port: number }> {
  const server = createServer((socket) => socket.end(text))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

/** Connect to a port on the loopback and read until the other side closes. */
export function readThrough(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let text = ''
    socket.on('data', (chunk) => (text += chunk.toString()))
    socket.on('end', () => resolve(text))
    socket.on('error', reject)
  })
}
