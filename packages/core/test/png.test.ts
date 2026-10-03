import { deflateSync } from 'node:zlib'
import { expect, test } from 'vitest'
import { decodePng, diffPngs, encodePng, type PngImage } from '../src/png.js'

/** A solid image, with the pixels named painted over it. */
function image(width: number, height: number, fill: [number, number, number, number], paint: Array<{ x: number; y: number; rgba: [number, number, number, number] }> = []): PngImage {
  const pixels = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) pixels.set(fill, index * 4)
  for (const { x, y, rgba } of paint) pixels.set(rgba, (y * width + x) * 4)
  return { width, height, pixels }
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255]
const BLACK: [number, number, number, number] = [0, 0, 0, 255]
const RED: [number, number, number, number] = [255, 0, 0, 255]

const pixelAt = (picture: PngImage, x: number, y: number): number[] => [...picture.pixels.subarray((y * picture.width + x) * 4, (y * picture.width + x) * 4 + 4)]

test('an image survives being written and read back', () => {
  const original = image(3, 2, WHITE, [{ x: 1, y: 1, rgba: [10, 20, 30, 40] }])
  const png = encodePng(original)

  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const decoded = decodePng(png)
  expect(decoded.width).toBe(3)
  expect(decoded.height).toBe(2)
  expect(decoded.pixels.equals(original.pixels)).toBe(true)
})

/** A PNG chunk with a zero checksum: the reader does not verify checksums, the browser wrote them. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}

function rawPng(width: number, height: number, colorType: number, scanlines: number[][], interlace = 0, depth = 8): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([depth, colorType, 0, 0, interlace], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(scanlines.flat()))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('every scanline filter a browser writes is undone, on an image without alpha', () => {
  // 2x5 RGB, one filter per row: none, sub, up, average, paeth.
  const png = rawPng(2, 5, 2, [
    [0, 10, 20, 30, 40, 50, 60],
    [1, 10, 20, 30, 30, 30, 30],
    [2, 1, 1, 1, 1, 1, 1],
    [3, 5, 5, 5, 5, 5, 5],
    [4, 1, 2, 3, 1, 2, 3],
  ])
  const decoded = decodePng(png)

  expect(pixelAt(decoded, 0, 0)).toEqual([10, 20, 30, 255])
  expect(pixelAt(decoded, 1, 0)).toEqual([40, 50, 60, 255])
  // sub: each byte adds the pixel to its left.
  expect(pixelAt(decoded, 1, 1)).toEqual([40, 50, 60, 255])
  // up: each byte adds the pixel above.
  expect(pixelAt(decoded, 0, 2)).toEqual([11, 21, 31, 255])
  expect(pixelAt(decoded, 1, 2)).toEqual([41, 51, 61, 255])
  // average: the floor of the mean of left and above.
  expect(pixelAt(decoded, 0, 3)).toEqual([10, 15, 20, 255])
  expect(pixelAt(decoded, 1, 3)).toEqual([30, 38, 45, 255])
  // paeth: the nearest of left, above and upper left.
  expect(pixelAt(decoded, 0, 4)).toEqual([11, 17, 23, 255])
  expect(pixelAt(decoded, 1, 4)).toEqual([31, 40, 48, 255])
})

test('a file that is not a PNG this reader can vouch for is refused, naming why', () => {
  expect(() => decodePng(Buffer.from('not a png at all'))).toThrow('not a PNG')
  expect(() => decodePng(rawPng(1, 1, 3, [[0, 0]]))).toThrow('colour type 3')
  expect(() => decodePng(rawPng(1, 1, 6, [[0, 0, 0, 0, 0]], 1))).toThrow('interlaced')
  expect(() => decodePng(rawPng(1, 1, 6, [[0, 0, 0, 0, 0]], 0, 16))).toThrow('bit depth 16')
  // Fewer pixel bytes than the header promises.
  expect(() => decodePng(rawPng(2, 2, 6, [[0, 0, 0, 0, 0]]))).toThrow('truncated')
})

test('two encodings of the same pixels are identical, whatever their bytes', () => {
  const picture = image(2, 2, WHITE)
  const filtered = rawPng(2, 2, 6, [
    [0, 255, 255, 255, 255, 255, 255, 255, 255],
    [2, 0, 0, 0, 0, 0, 0, 0, 0],
  ])
  expect(filtered.equals(encodePng(picture))).toBe(false)

  expect(diffPngs(encodePng(picture), filtered)).toBe('identical')
})

test('a pixel that moved is marked in the diff image, and the rest is dimmed', () => {
  const base = encodePng(image(4, 4, WHITE, [{ x: 1, y: 1, rgba: BLACK }]))
  const head = encodePng(image(4, 4, WHITE, [{ x: 2, y: 1, rgba: BLACK }]))

  const diff = diffPngs(base, head)
  if (diff === 'identical') throw new Error('expected a difference')
  const picture = decodePng(diff)

  expect([picture.width, picture.height]).toEqual([4, 4])
  // Where the element was, and where it went.
  expect(pixelAt(picture, 1, 1)).toEqual(RED)
  expect(pixelAt(picture, 2, 1)).toEqual(RED)
  // Everything else is the head, dimmed, and never the marker colour.
  expect(pixelAt(picture, 0, 0)).toEqual(WHITE)
  expect(pixelAt(picture, 3, 3)).toEqual(WHITE)
})

test('an unchanged dark pixel is dimmed, so only differences carry the marker', () => {
  const base = encodePng(image(2, 1, BLACK, [{ x: 1, y: 0, rgba: WHITE }]))
  const head = encodePng(image(2, 1, BLACK, [{ x: 1, y: 0, rgba: [200, 200, 200, 255] }]))

  const diff = diffPngs(base, head)
  if (diff === 'identical') throw new Error('expected a difference')
  const picture = decodePng(diff)
  const [red, green, blue] = pixelAt(picture, 0, 0)

  expect(red).toBe(green)
  expect(green).toBe(blue)
  expect(red).toBeGreaterThan(150)
  expect(pixelAt(picture, 1, 0)).toEqual(RED)
})

test('images of different sizes differ, and the diff covers both', () => {
  const base = encodePng(image(2, 2, WHITE))
  const head = encodePng(image(3, 1, WHITE))

  const diff = diffPngs(base, head)
  if (diff === 'identical') throw new Error('expected a difference')
  const picture = decodePng(diff)

  expect([picture.width, picture.height]).toEqual([3, 2])
  // Shared and equal.
  expect(pixelAt(picture, 0, 0)).toEqual(WHITE)
  // Only one side has these.
  expect(pixelAt(picture, 2, 0)).toEqual(RED)
  expect(pixelAt(picture, 0, 1)).toEqual(RED)
})
