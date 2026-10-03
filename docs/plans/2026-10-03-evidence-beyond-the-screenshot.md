# Evidence beyond the screenshot

Issue #78

## Scope

In:

- A screen recording per flow, on the drivers that can take one (the browser
  and Electron): frames the driver takes through a new optional `frame` seam
  on the flow page, sampled by the flow itself and assembled by qare into one
  animated PNG, `recording.png`, in the check's evidence directory.
- A platform log for the browser driver (console messages, page errors, a
  crashed page), which until now only the Electron driver had, and a renderer
  crash line for both. Beside the whole `console.log`, a check that did not
  pass gets `failure.log`: the lines from the window around the failure.
- The accessibility tree snapshot at the point of an assertion. It already
  ships (#82) on both drivers; this issue proves it on a failing check and
  holds it to the same sweep as the rest.
- All of it redacted: the recording by construction (below), the logs and
  the snapshot by the run's rules, proven by a test that plants a secret and
  sweeps the evidence, and by real runs on both drivers.
- The seam for the drivers that do not exist yet (#73, #74, #85), and a
  statement of what is unexercised.

Out:

- A viewer for any of it (the issue's own out of scope).
- Native video (webm, mp4). A video cannot be masked or text-redacted, the
  evidence sweep refuses a binary it cannot vouch for, and ffmpeg would be a
  new dependency. A driver that can only record natively is its own issue.
- Crash dumps as files. A minidump is a memory image: it can hold any secret
  the process held and nothing here can sweep it, so it is never published.
  What is published is the crash itself, as a line in the platform log.
- Runner capabilities and host requirements in the evidence (#76, in flight),
  macOS and Windows hosts (#90), and #77, #224. No result schema change here.

## Assumptions

- **A recording is frames, not a video.** Each frame is a screenshot the
  driver takes with the profile's masks applied, so a frame carries the same
  guarantee a screenshot does (#119). The flow samples one after every action
  and one every 500 ms while an action is in flight. qare assembles them into
  an animated PNG: it stays an image, so the evidence sweep, the `qa-assets`
  push and the comment's links treat it as they treat a screenshot, with no
  new file kind and no new dependency.
- **How a recording is kept free of credentials.** Three rules, all in code:
  1. Masks applied: every frame is taken with the profile's `redact.masks`.
  2. Typed secrets never rendered: when a flow types a value the run's
     redaction would sweep from the action log, the element it typed into is
     blacked out in every frame and every screenshot taken from then on. The
     element is concealed before the value is typed.
  3. Withheld while a one-time code is on the page: the recording stops
     before a `totp` or `backupCode` is typed, as screenshots already do
     (#64), and is not started at all when a mail-borne code is on the page.
     The frames taken before that point are kept.
- **Kept only when the check did not pass.** A recording is taken for every
  flow, and written to the evidence only for a flow that failed or was
  unverified at an action. A passing flow's frames are dropped and the action
  log says so. This is the evidence size decision: screenshots already show
  where a passing flow ended.
- **Bounds.** At most 120 distinct frames and 4 MiB of frame data; past
  either, the oldest frames are dropped, since the end of the flow is where
  the failure is. Identical consecutive frames are one frame shown longer; a
  still is shown for at most 5 s. A frame is given 5 s to be taken. The
  failure log keeps the 30 s before the failure and what followed, at most
  200 lines before and 100 after.
- **One capture at a time.** Frames, screenshots and accessibility audits of
  one check are serialised by the flow, so a frame's masks are never put up
  or taken down under another capture.
- **A flow that outlives its timeout** hands back no outcome, so it keeps no
  recording; its `failure.log` is still written, from the time it stopped.
- **The browser driver now writes `console.log`** for every flow check, as
  the Electron driver does. `scripts/electron-driver.sh` asserted the
  opposite, and changes with it.
- No version bump: the change is additive to the evidence directory.

## Tasks

- [x] 1. Animated PNG assembly (`apng.ts`): frames in, one animated PNG out,
  and back again. Failing test: three frames assembled, split back into the
  same pixels with their delays; a frame of another size is skipped and
  counted; the evidence sweep reads the result as an image.
- [x] 2. Platform log (`platform-log.ts`): a bounded, timestamped log and the
  excerpt around a moment. Failing test: lines kept with their times, bounds
  as the Electron driver has them, an excerpt holding only the window.
- [x] 3. Recording in the flow (`flow.ts`): the `frame` seam, sampling, the
  three credential rules, the bounds, kept only when the check did not pass.
  Failing tests: a failed assert writes `recording.png` and lists it; a
  passing flow keeps none; a typed secret conceals its element before the
  type and in every later frame and screenshot; a second factor stops the
  recording before it is typed; the bounds drop the oldest frames.
- [x] 4. Browser driver: `frame`, concealed screenshots, console, page errors
  and crashes. Failing tests against the fake chromium.
- [ ] 5. Electron driver: `frame`, concealed screenshots, a crashed window,
  the shared platform log. Failing tests against the fake application.
- [ ] 6. The run (`run.ts`): `failure.log` for a check that did not pass,
  `console.log` for the browser, and the planted secret: a failing flow on a
  fake session that types, logs and shows a secret leaves a recording, a log
  excerpt and a snapshot, and no byte of the secret anywhere in the evidence.
- [ ] 7. Real runs on both drivers: the example application gains a field
  whose value it logs, a failing plan types a planted secret into it, and
  `scripts/electron-driver.sh` holds the browser and the contained desktop
  build to a recording, a log excerpt and a snapshot with no secret in them.
- [ ] 8. Docs: SPEC (clients, the Electron driver, output), the evidence
  directory layout, and what is unexercised for the drivers to come.
