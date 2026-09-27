# The image extension contract

QARE's images are layered. A project that needs something unusual starts from
the base and adds only that, and a derived image keeps working across QARE
releases as long as it relies on this contract and nothing else. The contract
has three parts: stable paths, a stable entry point and user, and tags a
derived image can pin against.

Every image in the family publishes this contract. A release that breaks it is
a release that breaks derived images, so the release workflow builds the
worked example on every release and runs it.

## Stable paths

| Path | What it holds | Who writes it |
| --- | --- | --- |
| `/opt/qare` | QARE's home. Everything the base ships lives below it. | the base |
| `/opt/qare/bin` | Executables, including the entry point. | the base |
| `/opt/qare/config` | Configuration the image ships, such as profile defaults. | the base |
| `/opt/qare/cache` | Scratch and cache space. Writable at run time. | the image user |
| `/opt/qare/drivers` | One directory per driver family, added by derived images. | derived images |
| `/opt/qare/tools` | Host tools QARE did not ship, added by derived images. | derived images |
| `/work` | Default working directory for a run. | the image user |

A derived image may add files under `/opt/qare/drivers` and
`/opt/qare/tools`. It must not rewrite, shadow or delete anything the base
ships. The base is built once and derived images add to it, which is what
keeps nothing installed twice.

## Entry point and user

The entry point is `qare` at `/opt/qare/bin/qare`, and `/opt/qare/bin` is on
`PATH`. A derived image may wrap it, but must leave it named `qare` and must
`exec` the original, so the base's signal handling and exit codes survive.

Images run as a non-root user named `qare`, uid and gid 1000. A derived image
ends `USER qare`, and anything it copies in must be readable and executable by
that user. `/opt/qare/cache` and `/work` are the writable paths.

## Tags

The base images are published to the GitHub container registry under
`ghcr.io/vividynamics/qare-core`:

| Tag | Meaning |
| --- | --- |
| `2026.9.0` | One exact release. Reproducible builds pin this. |
| `2026.9` | The newest release on a line. Follows the line. |
| `latest` | The newest release. Convenient, never pinned. |

A derived image that must not move pins the exact release tag. One that
prefers staying current pins the release line and rebuilds on release, which is
what the worked example does.

## The worked example

`examples/derived-image` is a derived image that adds a custom driver and a
host tool:

```sh
docker build -t scale-driver examples/derived-image
docker run --rm scale-driver /opt/qare/bin/qare --version
```

The example registers a device rig as a driver under
`/opt/qare/drivers/scale-driver`, and a small measurement tool at
`/opt/qare/tools/measure`. Both are ordinary executables, readable and
runnable by the `qare` user. A profile that wants them names their paths; how
a profile registers tools is the host-tools documentation's subject, not this
contract's.

## The release guard

Every release builds the worked example from the release's own images and runs
a smoke check inside the container: the entry point answers, the driver runs,
and the tool runs, all as the `qare` user. A release that breaks the contract
goes red there, so a release cannot break derived images silently.
