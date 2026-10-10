# The desktop-linux flavour (#89): built FROM core, adding one driver
# family: a virtual display, the accessibility bus, and the at-spi tree
# bridge, which runs as a separate process beside whatever a desktop run
# drives. It reinstalls nothing the base already has: every system package
# and every file the base ships stays exactly as the base built it, which
# the CI check (images/check-derived.sh) enforces.
#
# The base is an ARG, so a build pins it (docs/images.md):
#   docker build --build-arg QARE_IMAGE=ghcr.io/vividynamics/qare-core:2026.9.1 .
ARG QARE_IMAGE=ghcr.io/vividynamics/qare-core@sha256:dde359505efbdc6336f776f068b5805c7164fd593083c4850ed1f5f83dfc67ef

FROM $QARE_IMAGE

# The pinned driver: at-spi2 is the tree bridge this flavour ships, pinned
# to the version bookworm provides, exactly as the web flavour pins its
# browser. The display and the bus are supporting system packages, installed
# at the archive's versions the way the web flavour installs xvfb.
ARG ATSPI_VERSION=2.46.0-5
ARG IMAGE_NAME=qare-desktop-linux

LABEL org.opencontainers.image.title=$IMAGE_NAME \
      org.opencontainers.image.description="QARE desktop-linux: the core image plus the desktop accessibility driver family" \
      org.opencontainers.image.source=https://github.com/ViviDynamics/qare

# The tree bridge is at-spi2's own bus launcher: it runs as its own process
# when a session bus starts, and the run's driver talks to the accessibility
# tree it exposes.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb dbus "at-spi2-core=$ATSPI_VERSION" \
 && rm -rf /var/lib/apt/lists* \
 && mkdir -p /opt/qare/drivers/desktop-linux \
 && node -e "process.stdout.write(JSON.stringify({ name: 'desktop-linux', drivers: { atspi: '$ATSPI_VERSION' }, bridge: 'at-spi bus launcher (separate process)', display: 'xvfb' }))" \
      > /opt/qare/drivers/desktop-linux/DRIVER.json \
 && chown -R qare:qare /opt/qare/drivers/desktop-linux

# The flavour's name reaches the run's evidence: the image sets it, and the
# runner hands the image's ref and digest through the environment beside it.
ENV QARE_FLAVOUR=desktop-linux
ENV QARE_DRIVER_VERSIONS=atspi=$ATSPI_VERSION

# The contract's user again: the base's USER stands, but a build that ran as
# root above must end as the image runs, as the qare user.
USER qare
WORKDIR /work
