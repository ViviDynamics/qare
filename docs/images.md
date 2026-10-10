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
| `2026.9.0` | One named release. Resolve its digest to pin its bytes. |
| `2026.9` | The newest release on a line. Follows the line. |
| `latest` | The newest release. Convenient, never pinned. |

A derived image that must not move uses `image@sha256:<digest>`. The shipped
flavour recipes default to a verified published core digest. Release builds
override that default with the digest returned by their own core build, so
all flavours inherit the core that this release actually produced. Explicit
local build arguments remain available for CI's local core image.

The core recipe pins both Python stages by digest and verifies the nare
wheel's SHA-256 before pip installs it. Its builder reads the hashed
`packageManager` declaration through Corepack. These checks verify the named
inputs; apt packages and pip's transitive dependencies are not fully locked.
Updating nare requires updating both its release URL and wheel hash.

## The shipped family

QARE ships four images of its own (#88 the base and the web flavour, #89 the
android and desktop-linux flavours), all built from this repository's
`images/` recipes and published by the release workflow for amd64 and arm64,
except where a driver's hardware says otherwise:

| Image | What it adds to the base |
| --- | --- |
| `ghcr.io/vividynamics/qare-core` | The smallest thing that runs QARE at all: the CLI, the ledger, the judge, command and mail checks, the exploration tool servers, and a pinned nare. No client driver. |
| `ghcr.io/vividynamics/qare-web` | Built `FROM core`: the browser engine, its browsers, a virtual display for headed runs, and GTK 3, which an Electron build needs beside the browser's libraries (#72). The Electron driver runs here and starts the display itself. |
| `ghcr.io/vividynamics/qare-android` | Built `FROM core` (amd64 only: the emulator's system image is an x86_64 build): the android sdk, an emulator, an avd, and the preboot check that names what the host must provide before anything boots. |
| `ghcr.io/vividynamics/qare-desktop-linux` | Built `FROM core`: a virtual display, the accessibility bus, and the at-spi tree bridge as a separate process. |

The core image holds a size budget (`images/core/size-budget`), and the CI
workflow fails when a change grows the image past it: the budget is what keeps
the base the smallest thing that runs QARE, not a number that drifts. Every
image pins the versions it ships and stamps them at
`/opt/qare/config/IMAGE.json`, and a derived flavour stamps its driver
versions beside its drivers at `/opt/qare/drivers/<flavour>/DRIVER.json`. A
run inside the image reads both into its evidence, so a run names the image
digest, the flavour and the versions that produced it rather than asking the
registry. The pipeline gives nested cells the same immutable image through
`QARE_IMAGE_REF`; `QARE_IMAGE_TAG` carries the release tag for evidence alone.
Local callers may keep using `QARE_IMAGE_REF` without a separate tag.

No derived image reinstalls anything the base already has, and CI enforces
that: `images/check-derived.sh` builds the family, compares the bytes of the
files the base ships in every derived image, and fails when a derived image
touched any of them. A derived recipe that reinstalled node, say, would grow
every pull of the flavour and shadow the base's own pin.

The android flavour adds a second guard to the release: its preboot check
runs from the published image on a hosted runner that has hardware
virtualisation and must pass, and the same image must refuse before booting
on a host that has none, naming the requirement it misses. A release that
cannot run the family's checks is refused rather than shipped.

## Building a flavour

A flavour declares its base through one argument, so the same recipe builds
against any contract-conformant image:

```sh
docker build -f images/web/Dockerfile \
  --build-arg QARE_IMAGE=ghcr.io/vividynamics/qare-core@sha256:dde359505efbdc6336f776f068b5805c7164fd593083c4850ed1f5f83dfc67ef .
```

The base argument is the whole inheritance. A flavour recipe installs only
its own driver family under `/opt/qare/drivers`, names its driver versions in
`DRIVER.json`, sets its flavour name in the environment, and ends `USER qare`.
Everything else — paths, entry point, user, tags — is the contract above.

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

Every release builds the worked example and runs a smoke check inside the
container: the entry point answers, the driver runs, and the tool runs, all as
the `qare` user with uid and gid 1000. The release publishes only after the
guard passes, so a release that breaks the contract is refused rather than
shipped.

Every release publishes the shipped family first, then builds the worked
example against the published core for that release and runs the smoke check
inside it. The contract-conformant fixture stamped with the release version
is the fallback for a release whose published base is not reachable, so the
check stays about the example and the contract rather than the base.

The shared core runtime pins nare **2026.10.6**, machine contract 1. All derived
flavours and the pipeline planner/judge inherit that installation. Host callers
can install the same wheel from the [nare release](https://github.com/ViviDynamics/nare/releases/tag/2026.10.6)
in a separate Python 3.12+ environment.
