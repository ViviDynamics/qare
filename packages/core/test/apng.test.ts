import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ApngError, assembleApng, splitApng } from '../src/apng.js'
import { decodePng, encodePng } from '../src/png.js'
import { redactEvidenceDir } from '../src/redact.js'

/** A frame of one flat colour, as a PNG. */
function frame(width: number, height: number, colour: [number, number, number]): Buffer {
  const pixels = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) pixels.set([...colour, 255], index * 4)
  return encodePng({ width, height, pixels })
}

test('frames go in and one animated PNG comes out, holding every frame and how long it is shown (#78)', () => {
  const red = frame(4, 3, [255, 0, 0])
  const green = frame(4, 3, [0, 255, 0])
  const blue = frame(4, 3, [0, 0, 255])

  const assembled = assembleApng([
    { png: red, delayMs: 500 },
    { png: green, delayMs: 1250 },
    { png: blue, delayMs: 40 },
  ])

  expect(assembled.frames).toBe(3)
  expect(assembled.skipped).toBe(0)
  // A reader that knows nothing of animation still reads a PNG: the first frame.
  expect(decodePng(assembled.apng).pixels.equals(decodePng(red).pixels)).toBe(true)

  const split = splitApng(assembled.apng)
  expect(split.map((entry) => entry.delayMs)).toEqual([500, 1250, 40])
  expect(split.map((entry) => [...decodePng(entry.png).pixels.subarray(0, 4)])).toEqual([
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
  ])
  for (const entry of split) expect(decodePng(entry.png)).toMatchObject({ width: 4, height: 3 })
})

test('a frame that is not the size of the first is skipped and counted, never stretched (#78)', () => {
  const assembled = assembleApng([
    { png: frame(4, 3, [255, 0, 0]), delayMs: 100 },
    { png: frame(8, 3, [0, 255, 0]), delayMs: 100 },
    { png: frame(4, 3, [0, 0, 255]), delayMs: 100 },
  ])

  expect(assembled.frames).toBe(2)
  expect(assembled.skipped).toBe(1)
  expect(splitApng(assembled.apng).map((entry) => [...decodePng(entry.png).pixels.subarray(0, 3)])).toEqual([
    [255, 0, 0],
    [0, 0, 255],
  ])
})

test('a still is shown no longer than the format can say, and no frames at all is refused by name (#78)', () => {
  const assembled = assembleApng([{ png: frame(2, 2, [1, 2, 3]), delayMs: 10 * 60 * 1000 }])
  expect(splitApng(assembled.apng).map((entry) => entry.delayMs)).toEqual([65_535])

  expect(() => assembleApng([])).toThrow(ApngError)
  expect(() => assembleApng([{ png: Buffer.from('not a png'), delayMs: 1 }])).toThrow(/not a PNG/)
  expect(() => splitApng(frame(2, 2, [1, 2, 3]))).toThrow(/not an animated PNG/)
})

test('the evidence sweep reads a recording as an image, like a screenshot (#78)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-apng-'))
  const assembled = assembleApng([
    { png: frame(4, 3, [255, 0, 0]), delayMs: 100 },
    { png: frame(4, 3, [0, 255, 0]), delayMs: 100 },
  ])
  await writeFile(join(dir, 'recording.png'), assembled.apng)

  expect(await redactEvidenceDir(dir)).toEqual({ files: ['recording.png'], changed: [], images: ['recording.png'] })
})
