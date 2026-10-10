# The core image (#88): the smallest thing that runs QARE at all. The CLI,
# the ledger, the judge, the command and mail checks, the exploration tool
# servers qare ships, and a pinned nare. No client driver: the flavours build
# FROM this and add one driver family each, so nothing is installed twice.
#
# The stable paths, the entry point and the user are the image extension
# contract (docs/images.md): /opt/qare/bin on PATH, the qare user at uid and
# gid 1000, and the writable paths /opt/qare/cache and /work.
#
# The base is python 3.12 because the pinned nare requires it, with node 22
# beside it: Python is digest-pinned; node stays on its declared major. The build is
# two stages: the workspace compiles in the builder with its full dev tree,
# and the runtime stage receives only the compiled output and the production
# dependencies — no typescript, no eslint, no test runners, no npm, no pnpm.
# A layer never deletes what an earlier layer wrote, so every byte the
# runtime stage keeps has to be written there only once, which is why the
# workspace lands as a single COPY that is already owned by the qare user.
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS builder

ARG NODE_MAJOR=22

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg binutils \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && strip --strip-unneeded /usr/bin/node \
 && rm -rf /var/lib/apt/lists*

# QARE itself: the workspace is copied unbuilt and built here, so the image
# never ships a stale dist and every architecture compiles its own native
# code during a multi-architecture build. After the build node_modules is
# pruned to production and the sources are dropped: the dist output and the
# package manifests are all the runtime needs.
WORKDIR /opt/qare/lib
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN corepack enable \
 && pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm install --frozen-lockfile --prod \
 && pnpm prune --prod \
 && rm -rf packages/*/src packages/*/test packages/*/fixtures packages/*/tsconfig.json

# The runtime stage. The image runs on the builder's node, copied over as a
# bare binary: the slim base already carries the runtime libraries node
# needs, so no package toolchain is installed into the final image at all.
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

ARG NARE_WHEEL=https://github.com/ViviDynamics/nare/releases/download/2026.10.6/nare-2026.10.6-py3-none-any.whl
ARG NARE_SHA256=4928ca85abe1859b58791f59510b50d090d7c1bff7eab75de3c44f7ac54ccd36
ARG IMAGE_NAME=qare-core

LABEL org.opencontainers.image.title=$IMAGE_NAME \
      org.opencontainers.image.description="QARE core: the smallest image that runs QARE at all" \
      org.opencontainers.image.source=https://github.com/ViviDynamics/qare

COPY --from=builder /usr/bin/node /usr/bin/node

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists*

# The contract's qare user, before anything of QARE's lands, so every copy
# that follows can arrive owned by it.
RUN groupadd --gid 1000 qare \
 && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin qare \
 && mkdir -p /opt/qare/bin /opt/qare/cache /opt/qare/drivers /opt/qare/tools /work \
 && chown qare:qare /opt/qare/cache /opt/qare/drivers /opt/qare/tools /work

COPY --from=builder --chown=qare:qare /opt/qare/lib /opt/qare/lib

# The hash-verified nare: the same wheel the pipeline's plan and judge steps pin, so
# a container run and a host run speak one nare contract. Bytecode is not
# precompiled: the first run in a container writes its own cache.
RUN mkdir -p /tmp/qare-nare \
 && python3 -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$NARE_WHEEL" /tmp/qare-nare/nare-2026.10.6-py3-none-any.whl \
 && printf '%s  %s\n' "$NARE_SHA256" /tmp/qare-nare/nare-2026.10.6-py3-none-any.whl | sha256sum --check --strict - \
 && python3 -m pip install --no-compile --no-cache-dir --break-system-packages /tmp/qare-nare/nare-2026.10.6-py3-none-any.whl \
 && rm -rf /tmp/qare-nare

# The image's own record: what a run reads into its evidence. Every version
# the image ships is pinned and named here, so evidence names the versions
# that produced it.
WORKDIR /opt/qare/lib
COPY images/core/image-info.mjs images/core/image-info.mjs
RUN mkdir -p /opt/qare/config \
 && node images/core/image-info.mjs "$IMAGE_NAME" > /opt/qare/config/IMAGE.json

COPY images/core/entry.sh /opt/qare/bin/qare
RUN chmod 755 /opt/qare/bin/qare

ENV PATH=/opt/qare/bin:/usr/local/bin:/usr/bin:/bin
ENV QARE_CONTAINER=1
ENV QARE_FLAVOUR=core

USER qare
WORKDIR /work
