# The example builds on the newest release by default, so a plain build works,
# and a build that must not move pins its base through the same argument:
#   docker build --build-arg QARE_IMAGE=ghcr.io/vividynamics/qare-core:2026.9.0 .
ARG QARE_IMAGE=ghcr.io/vividynamics/qare-core:latest
FROM $QARE_IMAGE

# A derived image adds a driver family and host tools under the contract paths
# and ships no files of its own elsewhere.
COPY drivers/scale-driver/probe /opt/qare/drivers/scale-driver/probe
COPY tools/measure /opt/qare/tools/measure

USER qare
WORKDIR /work
