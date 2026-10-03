# QA for compose-app, on a host it cannot run on

The same app as `../.qa`, under a profile that requires macOS
(`requires.os: macos`). It exists so qare's own CI, which runs on Linux, shows
a run refusing by name before anything is provisioned (#76): no compose
project, no base checkout, and a `result.json` that says what was required
and which kind of host it landed on.
