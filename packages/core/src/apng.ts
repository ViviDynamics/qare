import { PNG_SIGNATURE, pngChunk } from './png.js'

/**
 * A flow's screen recording (#78) is frames the driver took as screenshots,
 * put together here into one animated PNG. It stays an image: a reader that
 * knows nothing of animation shows the first frame, the evidence sweep reads
 * it as it reads a screenshot, and no encoder is needed beside the one each
 * frame already went through, because a frame's compressed pixels are moved
 * into the animation as they are.
 */
export interface ApngFrame {
  /** The frame, as the PNG the driver took. */
  png: Buffer
  /** How long the frame is shown before the next one. */
  delayMs: number
}

/** The longest one frame can be shown: the format counts a delay in sixteen bits. */
const MAX_DELAY_MS = 65_535

export class ApngError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApngError'
  }
}

interface PngParts {
  header: Buffer
  data: Buffer
}

/** A PNG's header and its compressed pixels, which is all of it an animation carries. */
function partsOf(png: Buffer): PngParts {
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new ApngError('a frame is not a PNG')
  let header: Buffer | undefined
  const data: Buffer[] = []
  for (const part of chunksOf(png)) {
    if (part.type === 'IHDR') header = part.body
    else if (part.type === 'IDAT') data.push(part.body)
  }
  if (header === undefined || header.length < 13 || data.length === 0) throw new ApngError('a frame is a PNG with no header or no pixels')
  return { header, data: Buffer.concat(data) }
}

function* chunksOf(png: Buffer): Generator<{ type: string; body: Buffer }> {
  let offset = PNG_SIGNATURE.length
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (body.length < length) throw new ApngError(`the PNG is truncated inside its ${type} chunk`)
    yield { type, body }
    if (type === 'IEND') return
    offset += 12 + length
  }
}

function frameControl(sequence: number, header: Buffer, delayMs: number): Buffer {
  const body = Buffer.alloc(26)
  body.writeUInt32BE(sequence, 0)
  header.copy(body, 4, 0, 8)
  // No offset: every frame covers the whole canvas.
  body.writeUInt16BE(Math.min(MAX_DELAY_MS, Math.max(0, Math.round(delayMs))), 20)
  body.writeUInt16BE(1000, 22)
  // Nothing is disposed of and nothing is blended: each frame replaces the last.
  body.set([0, 0], 24)
  return pngChunk('fcTL', body)
}

/**
 * Assemble frames into one animated PNG that plays once. The first frame
 * names the canvas; a frame whose header differs (another size, another
 * colour type: a viewport that was resized under the recording) cannot sit
 * on it, and is skipped and counted, never stretched.
 */
export function assembleApng(frames: readonly ApngFrame[]): { apng: Buffer; frames: number; skipped: number } {
  if (frames.length === 0) throw new ApngError('a recording has no frames')
  const first = partsOf((frames[0] as ApngFrame).png)
  const kept: Array<{ data: Buffer; delayMs: number }> = []
  let skipped = 0
  for (const frame of frames) {
    const parts = kept.length === 0 ? first : partsOf(frame.png)
    if (!parts.header.equals(first.header)) {
      skipped += 1
      continue
    }
    kept.push({ data: parts.data, delayMs: frame.delayMs })
  }
  const control = Buffer.alloc(8)
  control.writeUInt32BE(kept.length, 0)
  control.writeUInt32BE(1, 4)
  const out: Buffer[] = [PNG_SIGNATURE, pngChunk('IHDR', first.header), pngChunk('acTL', control)]
  let sequence = 0
  for (const [index, frame] of kept.entries()) {
    out.push(frameControl(sequence, first.header, frame.delayMs))
    sequence += 1
    if (index === 0) {
      out.push(pngChunk('IDAT', frame.data))
      continue
    }
    const numbered = Buffer.alloc(4)
    numbered.writeUInt32BE(sequence, 0)
    sequence += 1
    out.push(pngChunk('fdAT', Buffer.concat([numbered, frame.data])))
  }
  out.push(pngChunk('IEND', Buffer.alloc(0)))
  return { apng: Buffer.concat(out), frames: kept.length, skipped }
}

/**
 * An animated PNG taken apart again: every frame as a PNG of its own, with
 * how long it is shown. What a test, or a reader with no viewer, holds a
 * recording to.
 */
export function splitApng(apng: Buffer): ApngFrame[] {
  if (apng.length < PNG_SIGNATURE.length || !apng.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new ApngError('the file is not a PNG')
  let header: Buffer | undefined
  let animated = false
  const frames: Array<{ delayMs: number; data: Buffer[] }> = []
  for (const part of chunksOf(apng)) {
    if (part.type === 'IHDR') header = part.body
    else if (part.type === 'acTL') animated = true
    else if (part.type === 'fcTL') {
      const denominator = part.body.readUInt16BE(22) || 100
      frames.push({ delayMs: Math.round((part.body.readUInt16BE(20) * 1000) / denominator), data: [] })
    } else if (part.type === 'IDAT') frames.at(-1)?.data.push(part.body)
    else if (part.type === 'fdAT') frames.at(-1)?.data.push(part.body.subarray(4))
  }
  if (!animated || header === undefined) throw new ApngError('the file is not an animated PNG')
  const canvas = header
  return frames.map((frame) => ({
    png: Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', canvas), pngChunk('IDAT', Buffer.concat(frame.data)), pngChunk('IEND', Buffer.alloc(0))]),
    delayMs: frame.delayMs,
  }))
}
