# A test stand-in for the published base image. The release guard needs a base
# that satisfies the contract, and the published base images are another
# issue's deliverable (#88), so this fixture exists only to be built against:
# the paths, the entry point, the qare user, and nothing more.
FROM alpine:3.20

RUN addgroup -g 1000 qare \
 && adduser -D -u 1000 -G qare qare \
 && mkdir -p /opt/qare/bin /opt/qare/config /opt/qare/cache \
      /opt/qare/drivers /opt/qare/tools /work \
 && chown -R qare:qare /opt/qare /work

COPY qare /opt/qare/bin/qare
COPY VERSION /opt/qare/config/VERSION
RUN chmod +x /opt/qare/bin/qare

USER qare
WORKDIR /work
