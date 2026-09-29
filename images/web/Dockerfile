# The web flavour (#88): built FROM core, adding one driver family: the
# browser engine, its browsers, and a virtual display for headed runs and
# desktop shells. It reinstalls nothing the base already has: every
# system package and every file the base ships stays exactly as the base
# built it, which the CI check (images/check-derived.sh) enforces.
#
# The base is an ARG, so a build pins it (docs/images.md):
#   docker build --build-arg QARE_IMAGE=ghcr.io/vividynamics/qare-core:2026.9.0 .
ARG QARE_IMAGE=ghcr.io/vividynamics/qare-core:latest

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
# pinned to the version playwright-core resolves, and the system packages
# they need are installed beside them.
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/qare/drivers/web/browsers
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb \
 && rm -rf /var/lib/apt/lists* \
 && npx --yes "playwright@$PLAYWRIGHT_VERSION" install --with-deps chromium \
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
