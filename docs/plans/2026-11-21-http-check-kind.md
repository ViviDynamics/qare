# An http check kind for API and backend criteria

Issue #378

## Scope

In:
- A plan and a job may carry an `http` check: a method from a fixed set, a path on the app under test, optional headers and a string body, a timeout, and `expect` matchers for the status, headers and JSON path values.
- The loader refuses anything outside the bounds: a method not in the set, a path that is not a path, too many headers or a header the client controls, a body over the cap, a timeout over the cap, no status matcher.
- The run resolves the path on the booted app's origin (the one the run proved healthy, so `{{run.app_port}}` is pinned for it) or below the profile's target URL, and on nothing else. A plan cannot name a host.
- The request carries only what the plan wrote, with run values substituted. Nothing from the job environment is added, redirects are not followed, and the response body is read up to a cap.
- The verdict is decided in code by the matchers. The evidence (`http.json`) records the request and the response status, headers and body, redacted by the run's rules, with secret-bearing headers (authorization, cookie, set-cookie, any header whose name names a secret) replaced, and the body excerpt size capped.
- The planner's schema and prompt describe the kind, offer it only when the profile boots an app or names a target, and keep it on a profile with no browser flavour. The plan step corrects an http check on a profile with no app to address.

Out:
- Mail artefacts (`{{mail.<name>.code}}`) inside an http check. Not asked for, and it would widen what flows into a request. Run values only.
- Full URLs or other hosts in an http check. The safety rule says the booted app or a declared target, and a path on one of them covers both.
- A body matcher beyond JSON path. The issue asks for status, header and JSON path matchers.

## Assumptions

- Method set: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS.
- Bounds: at most 32 headers, each value at most 8 KiB; a body of at most 64 KiB; a timeout of at most 120 s (default the check default); the response is read up to 1 MiB, and the evidence keeps up to 16 KiB of it.
- Headers the client controls (host, content-length, connection, transfer-encoding and the like) are refused at load, so a plan cannot set them.
- `expect.status` is required: a check that matches a header or a JSON value on a 500 has not shown the behaviour. It is one code or a list of codes.
- Header matchers reuse the tool matcher vocabulary (equals, contains, matches, exists) on a named header; JSON matchers reuse the tool assertion vocabulary on a dot path into the parsed body, evaluated by the same code (`evaluateToolAssertions`).
- A response that is not JSON fails a JSON matcher (the app answered, and the answer is wrong). One cut at the read cap leaves it unverified (the check could not look). Neither ever passes.
- Anything that is not the app's answer (no address to reach, connection refused, timeout) is unverified, as for a tool check. A response that does not match is failed.
- The execution lives in its own module (`http-run.ts`) that takes one input object, so `runCriterion` gets a short branch and no new positional argument.

## Tasks

- [x] 1. Plan and job shape: `parseHttpCheck` shared by the plan and job loaders, plan-lock canonical form, job-from-plan translation. Tests: the loaders accept a full http check and refuse each bound.
- [x] 2. Address resolution: `httpCheckUrl` resolves a path on the booted app or the target and refuses everything else. Tests: app origin with the run port, target base path, climbing paths, no app.
- [x] 3. Execution and evidence: `runHttpCheckJob` sends the request, reads the capped body, evaluates the matchers and writes redacted `http.json`. Tests: pass, status mismatch, header and JSON mismatch, non-JSON body, redirect not followed, timeout unverified, secrets redacted, body excerpt capped.
- [x] 4. Run wiring: `runCriterion` branch, run value substitution and plan-time validation. Test: a job against a target runs an http check end to end and the criterion is proven or failed by the matchers alone.
- [ ] 5. Planner: schema field and kind, prompt text, offered only with an app or a target, kept on a browserless profile, corrected when there is nothing to address. Tests in plan-step and plan-browserless suites.
- [ ] 6. Docs: SPEC section on the http check.
