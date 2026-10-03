import { assembleApng } from './apng.js'

/**
 * A flow's screen recording (#78). The driver takes frames; this samples
 * them, keeps them within bounds, and puts them together.
 *
 * A frame is a screenshot, taken by the driver with the profile's masks and
 * with every element the flow has concealed blacked out, so a recording
 * carries what a screenshot carries and nothing a screenshot would not. That
 * is the reason it is frames and not a video: a video is taken by the
 * platform, past every mask, and nothing can sweep it afterwards.
 */

/** How often a flow is sampled while an action is in flight. */
export const RECORDING_INTERVAL_MS = 500
/** The distinct frames one recording keeps. */
export const RECORDING_MAX_FRAMES = 120
/** The bytes of frames one recording keeps. */
export const RECORDING_MAX_BYTES = 4 * 1024 * 1024
/** How long a still is shown at most, however long the screen stood still. */
export const RECORDING_STILL_MAX_MS = 5_000
/** How long one frame is given to be taken. */
export const RECORDING_FRAME_TIMEOUT_MS = 5_000
/** How long the last frame is shown: the end of the flow is what a reader came for. */
const LAST_FRAME_MS = 2_000

export interface FlowRecordingOpts {
  /** How often the flow is sampled between its actions; 0 samples at the actions only. */
  intervalMs?: number
  maxFrames?: number
  maxBytes?: number
}

export interface AssembledRecording {
  apng: Buffer
  frames: number
  durationMs: number
  /** Frames dropped from the start to keep the recording within its bounds. */
  dropped: number
  /** Frames left out because they were not the size of the first. */
  skipped: number
}

export interface FlowRecorder {
  /** Take a frame now. Never throws: a frame that cannot be taken is counted. */
  sample(): Promise<void>
  /** Take no more frames, and wait for the one in flight. */
  stop(): Promise<void>
  /** Frames taken since the start, kept or not. */
  taken(): number
  /** Frames that could not be taken, and the first reason. */
  failures(): { count: number; first?: string }
  /** The bounds the recording was held to. */
  bounds(): { maxFrames: number; maxBytes: number }
  /** What was kept, put together; undefined when no frame was. */
  assemble(endedAt: number): AssembledRecording | undefined
}

export function makeFlowRecorder(opts: {
  /** One frame from the driver. */
  take: () => Promise<Uint8Array>
  /** Runs one capture at a time: a frame's masks are never put up under another capture. */
  exclusive: <T>(work: () => Promise<T>) => Promise<T>
  recording?: FlowRecordingOpts
  now: () => number
  frameTimeoutMs?: number
}): FlowRecorder {
  const intervalMs = opts.recording?.intervalMs ?? RECORDING_INTERVAL_MS
  const maxFrames = Math.max(1, opts.recording?.maxFrames ?? RECORDING_MAX_FRAMES)
  const maxBytes = opts.recording?.maxBytes ?? RECORDING_MAX_BYTES
  const frameTimeoutMs = opts.frameTimeoutMs ?? RECORDING_FRAME_TIMEOUT_MS

  const frames: Array<{ png: Buffer; at: number }> = []
  let bytes = 0
  let taken = 0
  let dropped = 0
  let failed = 0
  let firstFailure: string | undefined
  let stopped = false
  let sampling = false

  const keep = (png: Buffer): void => {
    taken += 1
    // A screen that did not change is the frame before it, shown longer.
    if (frames.at(-1)?.png.equals(png) === true) return
    frames.push({ png, at: opts.now() })
    bytes += png.length
    while (frames.length > 1 && (frames.length > maxFrames || bytes > maxBytes)) {
      bytes -= (frames.shift() as { png: Buffer }).png.length
      dropped += 1
    }
  }

  const takeOne = async (): Promise<void> => {
    if (stopped) return
    let timer: NodeJS.Timeout | undefined
    try {
      const frame = opts.take()
      // The loser of the race is drained: a frame that arrives late is dropped, not an unhandled rejection.
      void frame.catch(() => {})
      const png = await Promise.race([
        frame,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`the frame was not taken within ${frameTimeoutMs} ms`)), frameTimeoutMs)
          timer.unref()
        }),
      ])
      keep(Buffer.from(png))
    } catch (error) {
      failed += 1
      firstFailure ??= String(error)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const sample = async (): Promise<void> => {
    if (stopped) return
    sampling = true
    try {
      await opts.exclusive(takeOne)
    } finally {
      sampling = false
    }
  }

  // Between the actions the flow is sampled on a timer. One frame at a time:
  // a tick that finds a frame still being taken is skipped, not queued.
  const timer =
    intervalMs > 0
      ? setInterval(() => {
          if (!sampling) void sample()
        }, intervalMs)
      : undefined
  timer?.unref()

  return {
    sample,
    stop: async () => {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      // Whatever capture is in flight ends before the caller goes on.
      await opts.exclusive(async () => {})
    },
    taken: () => taken,
    failures: () => ({ count: failed, ...(firstFailure === undefined ? {} : { first: firstFailure }) }),
    bounds: () => ({ maxFrames, maxBytes }),
    assemble: (endedAt) => {
      if (frames.length === 0) return undefined
      const timed = frames.map((frame, index) => {
        const next = frames[index + 1]
        return { png: frame.png, delayMs: next === undefined ? LAST_FRAME_MS : Math.min(RECORDING_STILL_MAX_MS, Math.max(1, next.at - frame.at)) }
      })
      const assembled = assembleApng(timed)
      return {
        apng: assembled.apng,
        frames: assembled.frames,
        durationMs: Math.max(0, endedAt - (frames[0] as { at: number }).at),
        dropped,
        skipped: assembled.skipped,
      }
    },
  }
}
