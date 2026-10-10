# The web flavour (#88): built FROM core, adding one driver family: the
# browser engine, its browsers, and a virtual display for headed runs and
# desktop shells. It reinstalls nothing the base already has: every
# system package and every file the base ships stays exactly as the base
# built it, which the CI check (images/check-derived.sh) enforces.
#
# The base is an ARG, so a build pins it (docs/images.md):
#   docker build --build-arg QARE_IMAGE=ghcr.io/vividynamics/qare-core@sha256:dde359505efbdc6336f776f068b5805c7164fd593083c4850ed1f5f83dfc67ef .
ARG QARE_IMAGE=ghcr.io/vividynamics/qare-core@sha256:dde359505efbdc6336f776f068b5805c7164fd593083c4850ed1f5f83dfc67ef

FROM $QARE_IMAGE

# The pinned browser: the version tracks playwright-core in the workspace,
# the same pin the pipeline's flow browser install uses.
ARG PLAYWRIGHT_VERSION=1.63.0
ARG IMAGE_NAME=qare-web

LABEL org.opencontainers.image.title=$IMAGE_NAME \
      org.opencontainers.image.description="QARE web: the core image plus the browser driver family" \
      org.opencontainers.image.source=https://github.com/ViviDynamics/qare

# The browser driver family lands under /opt/qare/drivers/web (the contract's
# derived-image path) and touches nothing the base ships. The browsers are
# the ones the base's own playwright-core resolves, and the system packages
# they need are installed beside them. The base ships no npm, so the install
# runs through that playwright-core's CLI directly.
#
# A desktop shell is a browser in a window (#72), so this flavour hosts the
# Electron driver too: the driver starts the virtual display for each launch,
# and an Electron build needs GTK 3 beside the libraries chromium already
# brings. The build itself is the project's, never the image's.
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/qare/drivers/web/browsers
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb libgtk-3-0 \
 && rm -rf /var/lib/apt/lists* \
 && node /opt/qare/lib/packages/core/node_modules/playwright-core/cli.js install --with-deps chromium \
 && chown -R qare:qare /opt/qare/drivers/web

# The driver family's own record, beside its browsers: what the evidence
# reads when a run reports the driver versions that produced it.
RUN mkdir -p /opt/qare/drivers/web \
 && node -e "process.stdout.write(JSON.stringify({ name: 'web', drivers: { chromium: '$PLAYWRIGHT_VERSION' }, display: 'xvfb' }))" \
      > /opt/qare/drivers/web/DRIVER.json \
 && chown qare:qare /opt/qare/drivers/web/DRIVER.json

# The flavour's name reaches the run's evidence: the image sets it, and the
# runner hands the image's ref and digest through the environment beside it.
ENV QARE_FLAVOUR=web
ENV QARE_DRIVER_VERSIONS=chromium=$PLAYWRIGHT_VERSION

# The contract's user again: the base's USER stands, but a build that ran as
# root above must end as the image runs, as the qare user.
USER qare
WORKDIR /work
