# A flow that opens a path cannot reach the app the run booted

Issue #264

## Scope
In: a flow's `open` action that names a path opens it on the app the run
booted, at the origin of the profile's health check with the run's values
substituted and the port pinned. The plan step tells the planner the booted
app's address, with the run's port by name. A path with no app to be a page
of leaves the flow unverified with a reason. docs/SPEC.md documents it.

Out: paths on a target and paths inside a client build, which already
resolve (below the target URL, and inside the application by the electron
driver). Visual and a11y checks, which already resolve a path on the booted
app's origin. `qare check`, whose planner call is not changed here.

## Assumptions
- The origin is the one the run proved healthy: the health URL after
  substitution and port pinning, exactly what a visual check already uses.
- A path cannot leave the app: leading slashes are a path, never a
  protocol-relative URL.
- The planner is told `{{run.app_port}}` even when the health URL writes a
  fixed local port, because the run pins that port to its own.
- On the electron driver the fix does not apply: a client profile boots no
  app, and its driver resolves a path inside the application already.
- A valid profile always names an app, a target or a client, so the run can
  only meet a path with nowhere to go when the health URL names no http
  origin. The rule is written for both cases and tested at the function for
  the first.

## Tasks
- [x] 1. `bootedAppOrigin`, `plannedAppAddress` and `flowOpenUrl`: core/test/flow-app-path.test.ts
- [x] 2. The run resolves a flow's paths per attempt and per side, and leaves a path with no app unverified: same file
- [x] 3. The planner prompt says how a booted app is addressed: same file
- [x] 4. `qare plan` passes the address from the profile: cli/test/plan-command.test.ts
- [x] 5. docs/SPEC.md documents it; release 2026.10.23 stamped
