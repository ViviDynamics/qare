import { createServer } from 'node:net'
import { connect } from 'node:tls'
import { expect, test } from 'vitest'
import { dnsReply, hostName, httpHost, readDnsQuestion, tlsServerName } from '../src/cell-wire.js'

/** A DNS query as a resolver sends it: one question, recursion desired. */
function dnsQuery(name: string, type: number, id = 0x1234): Buffer {
  const labels = name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'latin1')]))
  const question = Buffer.concat([...labels, Buffer.from([0, type >> 8, type & 0xff, 0, 1])])
  const header = Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])
  return Buffer.concat([header, question])
}

test('a DNS question is read by name and type, and anything else is not a question (#223)', () => {
  expect(readDnsQuestion(dnsQuery('API.Example.Test', 1))).toMatchObject({ id: 0x1234, name: 'api.example.test', type: 1 })
  expect(readDnsQuestion(dnsQuery('api.example.test', 28))?.type).toBe(28)
  // A response, a message with no question, a name that runs off the end: none is answered.
  const response = dnsQuery('api.example.test', 1)
  response[2] = 0x81
  expect(readDnsQuestion(response)).toBeUndefined()
  expect(readDnsQuestion(Buffer.from([0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined()
  expect(readDnsQuestion(dnsQuery('api.example.test', 1).subarray(0, 20))).toBeUndefined()
  expect(readDnsQuestion(Buffer.alloc(3))).toBeUndefined()
  // A compression pointer has no business in a question.
  expect(readDnsQuestion(Buffer.concat([Buffer.from([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]))).toBeUndefined()
})

test('a DNS reply answers the question it was asked: an address, nothing, or no such name (#223)', () => {
  const query = readDnsQuestion(dnsQuery('api.example.test', 1))!
  const answered = dnsReply(query, { address: '127.0.0.1' })
  // The same id and question, marked a response, one answer: the address, never cached.
  expect(answered.readUInt16BE(0)).toBe(0x1234)
  expect(answered[2]! & 0x80).toBe(0x80)
  expect(answered[3]! & 0x0f).toBe(0)
  expect(answered.readUInt16BE(4)).toBe(1)
  expect(answered.readUInt16BE(6)).toBe(1)
  expect([...answered.subarray(answered.length - 4)]).toEqual([127, 0, 0, 1])
  expect(answered.readUInt32BE(answered.length - 10)).toBe(0)
  expect(readDnsQuestion(dnsQuery('api.example.test', 1))?.name).toBe('api.example.test')

  const empty = dnsReply(query, 'empty')
  expect(empty.readUInt16BE(6)).toBe(0)
  expect(empty[3]! & 0x0f).toBe(0)

  const none = dnsReply(query, 'nxdomain')
  expect(none.readUInt16BE(6)).toBe(0)
  expect(none[3]! & 0x0f).toBe(3)
})

/** The first bytes a real TLS client sends, taken off a socket. */
function clientHello(servername: string | undefined): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.once('data', (chunk) => {
        socket.destroy()
        server.close()
        resolve(chunk)
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no port'))
      const client = connect({ host: '127.0.0.1', port: address.port, ...(servername === undefined ? {} : { servername }), rejectUnauthorized: false })
      client.on('error', () => {})
    })
  })
}

test('the server name is read from a real TLS client hello (#223)', async () => {
  const hello = await clientHello('api.example.test')
  expect(tlsServerName(hello)).toEqual({ state: 'read', name: 'api.example.test' })
  // Half a hello is waited for, not guessed at.
  expect(tlsServerName(hello.subarray(0, 40))).toEqual({ state: 'more' })
  expect(tlsServerName(Buffer.alloc(0))).toEqual({ state: 'more' })
  // A hello that names no server is read, and has no name.
  expect(tlsServerName(await clientHello(undefined))).toEqual({ state: 'read' })
  // Anything that is not a TLS handshake is not waited for.
  expect(tlsServerName(Buffer.from('GET / HTTP/1.1\r\n\r\n'))).toEqual({ state: 'read' })
  // A hello cut short inside its own lengths is read as naming nothing, never thrown on.
  const cut = Buffer.from(hello.subarray(0, 60))
  cut.writeUInt16BE(55, 3)
  expect(tlsServerName(cut)).toEqual({ state: 'read' })
})

test('the host is read from an HTTP request head (#223)', () => {
  expect(httpHost(Buffer.from('GET /x HTTP/1.1\r\nUser-Agent: a\r\nHost: API.example.test:80\r\n\r\n'))).toEqual({ state: 'read', name: 'api.example.test' })
  expect(httpHost(Buffer.from('GET /x HTTP/1.1\r\nhost:api.example.test\r\n\r\nbody'))).toEqual({ state: 'read', name: 'api.example.test' })
  expect(httpHost(Buffer.from('GET /x HTTP/1.1\r\nHost: api.exam'))).toEqual({ state: 'more' })
  expect(httpHost(Buffer.from('GET /x HTTP/1.0\r\n\r\n'))).toEqual({ state: 'read' })
  // A head with no end is not waited for without limit.
  expect(httpHost(Buffer.alloc(9000, 0x61))).toEqual({ state: 'read' })
})

test('a host name is lower case, bounded, and made of what a name is made of (#223)', () => {
  expect(hostName('API.Example.Test.')).toBe('api.example.test')
  expect(hostName('1.1.1.1')).toBe('1.1.1.1')
  expect(hostName('')).toBeUndefined()
  expect(hostName('a b')).toBeUndefined()
  expect(hostName('evil.test\nrefused: nothing')).toBeUndefined()
  expect(hostName(`${'a'.repeat(254)}`)).toBeUndefined()
  expect(hostName(7)).toBeUndefined()
})
