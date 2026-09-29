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
# installed beside it: one python, one node, both pinned by this recipe.
FROM python:3.12-slim-bookworm

ARG NARE_WHEEL=https://github.com/ViviDynamics/nare/releases/download/2026.9.10/nare-2026.9.10-py3-none-any.whl
ARG NODE_MAJOR=22
ARG IMAGE_NAME=qare-core

LABEL org.opencontainers.image.title=$IMAGE_NAME \
      org.opencontainers.image.description="QARE core: the smallest image that runs QARE at all" \
      org.opencontainers.image.source=https://github.com/ViviDynamics/qare

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists* \
 && npm install --global pnpm@12.5.1

# The pinned nare: the same wheel the pipeline's plan and judge steps pin, so
# a container run and a host run speak one nare contract.
RUN python3 -m pip install --no-cache-dir --break-system-packages "$NARE_WHEEL"

# QARE itself: the workspace is copied unbuilt and built here, so the image
# never ships a stale dist and every architecture compiles its own native
# code during a multi-architecture build.
WORKDIR /opt/qare/lib
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm store prune

# The image's own record: what a run reads into its evidence. Every version
# the image ships is pinned and named here, so evidence names the versions
# that produced it.
COPY images/core/image-info.mjs images/core/image-info.mjs
RUN mkdir -p /opt/qare/config \
 && node images/core/image-info.mjs "$IMAGE_NAME" > /opt/qare/config/IMAGE.json

# The base's own uid 1000 user (node) makes room for the contract's qare user.
RUN userdel -r node 2>/dev/null || true \
 && groupdel node 2>/dev/null || true \
 && groupadd --gid 1000 qare \
 && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin qare \
 && mkdir -p /opt/qare/bin /opt/qare/cache /opt/qare/drivers /opt/qare/tools /work \
 && chown -R qare:qare /opt/qare /work

COPY images/core/entry.sh /opt/qare/bin/qare
RUN chmod 755 /opt/qare/bin/qare

ENV PATH=/opt/qare/bin:/usr/local/bin:/usr/bin:/bin
ENV QARE_CONTAINER=1
ENV QARE_FLAVOUR=core

USER qare
WORKDIR /work
