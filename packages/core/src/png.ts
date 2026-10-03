import { deflateSync, inflateSync } from 'node:zlib'

/**
 * The pixels of a screenshot, eight bits a channel, red green blue alpha.
 *
 * This is the diff backend of a visual check (#143): it reads the PNGs a
 * browser writes, compares them pixel by pixel, and writes the picture of
 * where they differ. It reads what a browser's screenshot is (eight bits a
 * channel, greyscale or colour, with or without alpha, not interlaced) and
 * refuses anything else by name, so a file it cannot vouch for is never
 * compared on a guess.
 */
export interface PngImage {
  width: number
  height: number
  pixels: Buffer
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Channels per pixel for the colour types read here. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

/** The colour a differing pixel is painted in the diff image. */
const MARKER = [255, 0, 0, 255] as const

export class PngError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PngError'
  }
}

export function decodePng(png: Buffer): PngImage {
  if (png.length < SIGNATURE.length || !png.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new PngError('the file is not a PNG')
  let width = 0
  let height = 0
  let colorType = -1
  const data: Buffer[] = []
  let offset = SIGNATURE.length
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (body.length < length) throw new PngError(`the PNG is truncated inside its ${type} chunk`)
    if (type === 'IHDR') {
      if (length < 13) throw new PngError('the PNG header is truncated')
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      colorType = body[9] ?? -1
      if (depth !== 8) throw new PngError(`a PNG of bit depth ${String(depth)} is not read here, only 8`)
      if (CHANNELS[colorType] === undefined) throw new PngError(`a PNG of colour type ${colorType} is not read here`)
      if (body[12] !== 0) throw new PngError('an interlaced PNG is not read here')
    } else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const channels = CHANNELS[colorType]
  if (channels === undefined || width === 0 || height === 0) throw new PngError('the PNG carries no usable header')
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(data))
  } catch (error) {
    throw new PngError(`the PNG's pixel data could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new PngError('the PNG is truncated: it carries fewer pixels than its header names')

  // Undo each scanline's filter in place: every byte is predicted from the
  // pixel to its left, the one above, and the one above and to the left.
  const lines = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const from = y * (stride + 1) + 1
    const to = y * stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (lines[to + x - channels] as number) : 0
      const up = y > 0 ? (lines[to + x - stride] as number) : 0
      const upLeft = y > 0 && x >= channels ? (lines[to + x - stride - channels] as number) : 0
      let predicted: number
      if (filter === 0) predicted = 0
      else if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) predicted = paeth(left, up, upLeft)
      else throw new PngError(`the PNG names scanline filter ${String(filter)}, which does not exist`)
      lines[to + x] = ((raw[from + x] as number) + predicted) & 0xff
    }
  }

  const pixels = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const at = index * channels
    const grey = channels <= 2
    pixels[index * 4] = lines[at] as number
    pixels[index * 4 + 1] = lines[grey ? at : at + 1] as number
    pixels[index * 4 + 2] = lines[grey ? at : at + 2] as number
    pixels[index * 4 + 3] = channels === 4 ? (lines[at + 3] as number) : channels === 2 ? (lines[at + 1] as number) : 255
  }
  return { width, height, pixels }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const byLeft = Math.abs(estimate - left)
  const byUp = Math.abs(estimate - up)
  const byUpLeft = Math.abs(estimate - upLeft)
  if (byLeft <= byUp && byLeft <= byUpLeft) return left
  return byUp <= byUpLeft ? up : upLeft
}

const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, checksum])
}

export function encodePng(image: PngImage): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const stride = image.width * 4
  const raw = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y += 1) image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * Compare two screenshots pixel by pixel. Equal pixels are `identical`,
 * whatever the bytes of the two files. Otherwise the answer is the diff
 * image: the head, dimmed to grey, with every pixel that differs painted in
 * the marker colour, and so is any area only one of the two covers.
 *
 * Throws PngError for a file it cannot read, so the caller reports the pair
 * as not compared rather than as equal or different.
 */
export function diffPngs(basePng: Buffer, headPng: Buffer): Buffer | 'identical' {
  const base = decodePng(basePng)
  const head = decodePng(headPng)
  if (base.width === head.width && base.height === head.height && base.pixels.equals(head.pixels)) return 'identical'
  const width = Math.max(base.width, head.width)
  const height = Math.max(base.height, head.height)
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4
      const inBase = x < base.width && y < base.height
      const inHead = x < head.width && y < head.height
      const baseAt = (y * base.width + x) * 4
      const headAt = (y * head.width + x) * 4
      const same = inBase && inHead && base.pixels.readUInt32BE(baseAt) === head.pixels.readUInt32BE(headAt)
      if (!same) {
        pixels.set(MARKER, out)
        continue
      }
      // The unchanged page stays readable under the marks, and can never be
      // mistaken for one: it is grey, and pale.
      const grey =
        0.299 * (head.pixels[headAt] as number) + 0.587 * (head.pixels[headAt + 1] as number) + 0.114 * (head.pixels[headAt + 2] as number)
      const dimmed = Math.round(255 - (255 - grey) / 4)
      pixels.set([dimmed, dimmed, dimmed, 255], out)
    }
  }
  return encodePng({ width, height, pixels })
}
