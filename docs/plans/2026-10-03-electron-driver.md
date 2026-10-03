# Electron driver

Issue #72

## Scope

In:

- A second flow driver, `electron`, behind the same page seam the browser
  driver answers (#70): it launches a packaged application, attaches to its
  windows, and drives the whole action vocabulary against them.
- Multi-window handling without a new action: an element reference is looked
  for in every open window, newest first, so a flow follows the application
  into a window it opens and back out when that window closes.
- Evidence: screenshots (with the profile's masks), the assertion snapshots
  and the trace the browser driver already produces, and the application's own
  console output (main process stdout and stderr, every window's console and
  page errors, window lifecycle) as `console.log` in the check's evidence,
  swept by the same redaction as the action log.
- A capability declaration that says what the driver cannot do, held at plan
  time and before a run boots: `visual` and `a11y` checks, an `open` of
  anything but a path inside the application, and profile sections the driver
  cannot honour are refused naming the driver, never found out halfway.
- The minimum a profile needs to name the build: a `client` section with the
  driver, the executable and its arguments.
- A real Electron application under `examples/electron-app`, packaged, and
  driven by the same `plan.json` the browser runs, in the web image under a
  virtual display; a CI job that holds that proof on hosted runners.

Out:

- Provisioning (#75): building, fetching or installing the artefact, a build
  for the base side, teardown beyond closing what the driver launched. The
  profile names an executable that is already there.
- Runner requirements and placement (#76): the driver names a missing display
  as the reason a run is blocked, and declares nothing about hosts.
- Screen recording, crash reports and a log excerpt windowed around a failure
  (#78). The console output ships whole, because #72 asks for it.
- The accessibility audit and visual captures on a desktop window. Both need
  the window resized and re-themed, which is the window manager's business
  rather than a viewport's; the driver declares it has neither.
- Following a popup in the browser driver. The shared flow stays in one
  window; the multi-window flow runs against the desktop build only.
- macOS and Windows hosts (#90). The driver is written against Playwright and
  node only, but it is proven on Linux.

## Assumptions

- **Attach over the DevTools protocol, not `_electron.launch`.** The research
  note on the issue points at Playwright's `_electron`. A spike against
  Electron 44.5.1 and playwright-core 1.63.0 showed `_electron.launch` reads
  the process's output itself and hands the process back only once the
  application is up, so everything the main process wrote while starting is
  lost to the caller, and startup is the output a reader most wants. The
  driver therefore starts the executable itself with
  `--remote-debugging-port=0` and attaches with Playwright's
  `chromium.connectOverCDP`: the same locators, pages, tracing and
  screenshots, every byte of output from the first, and no dependence on the
  Node inspector, so a build with the inspect fuse off still runs. No main
  process access is needed by anything in the vocabulary.
- **No new dependency in the workspace.** The driver uses `playwright-core`,
  already an optional dependency. Electron itself is a dev dependency of the
  example only (`examples/electron-app/package.json`, outside the pnpm
  workspace, with its own lockfile): MIT, about 15 MB of packages, and a 283 MB
  runtime its installer fetches only when the example is packaged.
- **How a profile names the binary is the minimum, and #75's to redesign.** A
  third profile shape beside `app` and `target`:
  `client: { driver: electron, executable: <path>, args: [...] }`. The path
  resolves from the repository the run checks. It is exclusive with `app` and
  `target`, has no stubs and no base side, like a target profile. A desktop
  application that needs a booted backend is #75's concept to provide.
- **One side only.** Nothing provisions a base build, so a client run has no
  base comparison, and the result says so (`client.comparison: none`). A
  several-app run refuses a client profile for the same reason it refuses a
  target one: check it in its own run.
- **`open` means a path inside the application.** A browser flow against a
  target opens pages by path; on the desktop the path resolves against the
  page the application's first window loaded (`/` is that page). A full URL is
  refused before the run boots: a desktop shell has no address bar, and
  pointing a privileged window at an arbitrary URL is not something a person
  does.
- **Each flow check launches the application fresh**, with a user data
  directory of its own that is removed afterwards, so one check's state never
  explains another's. The driver owns `--remote-debugging-port` and
  `--user-data-dir`; a profile naming either is refused. Everything else,
  including `--no-sandbox` where a container needs it, is the profile's to say.
- **A missing executable or display blocks the run**, named, before any check
  runs: it is the environment's fault, never a failed criterion. On Linux a
  host with no display but an Xvfb has one: the driver starts a virtual
  display for each launch and stops it afterwards, so the pipeline's execute
  step runs a client profile without being changed.
- **Egress is not recorded.** The main process can reach the network without
  a page ever seeing it, so the driver does not claim to list the hosts a run
  reached. A client profile has no target hosts to hold them against.
- **The second factor actions are declared** because the driver types them
  like any value, but a client profile has no `app.login` to seed the secret,
  so such a flow is unverified before it runs, with the reason the flow
  runner already gives. Seeding is provisioning (#75).
- **The web image hosts desktop shells.** It already ships the virtual
  display; Electron additionally needs GTK 3, which the recipe gains
  (`libgtk-3-0`, about 20 MB). A profile targets it with `flavour: web`.

## Tasks

- [x] 1. Profile `client` section: a profile names the driver, the executable
      and its arguments; malformed, conflicting and unsupported sections are
      refused by field (`profile.test.ts`).
- [x] 2. Capability declaration: `ELECTRON_FLOW_DRIVER`, the `checks` a driver
      serves, `flowDriverFor(profile)`; a plan with a `visual` or `a11y` check
      is refused at load and before boot, and the planner is not offered them
      (`flow-electron.test.ts`, `plan.test.ts`, `plan-step.test.ts`).
- [x] 3. The session: launch, attach, the vocabulary across windows, `open` by
      path, masked screenshots, snapshot, trace, console lines, dispose
      (`flow-electron.test.ts`, with a fake process and a fake Playwright).
- [x] 4. The run: a client profile is preflighted (blocked on a missing
      executable or display), its flows run through the Electron session,
      `console.log` is written redacted into the evidence, the result names
      the client, and a full URL in `open` refuses the run (`flow-run.test.ts`,
      `boot.test.ts`, `result.test.ts`, `evidence.test.ts`).
- [x] 5. CLI and doctor: `run --plan` and `plan` take the driver from the
      profile; doctor requires a display for a client profile.
- [x] 6. The example: a packaged Electron application, the shared plan, both
      profiles, and the script that runs the plan against the browser and the
      desktop build (`examples/test/electron-app.test.mjs`,
      `scripts/electron-driver.sh`).
- [x] 7. The web image gains GTK, CI gains the `electron-driver` job, and the
      spec, the image guide and the schema reference say what shipped.
