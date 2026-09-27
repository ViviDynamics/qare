# A derived image

A worked example of the image extension contract
([docs/images.md](../../docs/images.md)): a derived image that adds a custom
driver and a host tool to the base, and nothing else.

## Build and run

```sh
docker build -t scale-driver examples/derived-image
docker run --rm scale-driver /opt/qare/bin/qare --version
docker run --rm scale-driver /opt/qare/drivers/scale-driver/probe
docker run --rm scale-driver /opt/qare/tools/measure
```

The default base is the newest release, the `latest` tag. A build that must
not move pins the exact release tag:

```sh
docker build --build-arg QARE_IMAGE=ghcr.io/vividynamics/qare-core:2026.9.0 -t scale-driver examples/derived-image
```

## What it adds

- `drivers/scale-driver/probe`, a driver family's entry, under
  `/opt/qare/drivers/scale-driver`
- `tools/measure`, a host tool, under `/opt/qare/tools/measure`

Both are ordinary executables, readable and runnable by the `qare` user, and
the image ends `USER qare` so the container never runs as root.

The release workflow builds this example on every release and runs it, so a
release cannot break the contract silently. `test/base-fixture.Dockerfile` is
a test stand-in that satisfies the contract, so the example builds and runs
before the published base images exist.
