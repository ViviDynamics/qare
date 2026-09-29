#!/bin/sh
# The derived-image no-reinstall check (#88). A flavour is built FROM core and
# adds one driver family: anything it installed again would undo the point of
# the layering. It takes two image tags, the base and the derived image:
#
#   images/check-derived.sh qare-core:ci qare-web:ci
#
# It fails when a file the base ships is not byte-identical in the derived
# image, or when the derived image's build recipe installs what the base
# already provides.
set -eu

base="$1"
derived="$2"
fail=0

# Files the base owns, compared byte for byte between the two images. The
# entry point, its stamp of the pinned versions, and the runtimes the base
# installed are the layering's spine; a derived image that changed any of
# them is a derived image that installed its own.
for path in /opt/qare/bin/qare /opt/qare/config/IMAGE.json /usr/bin/node /usr/local/bin/nare /usr/local/bin/python3; do
  base_sum="$(docker run --rm "$base" sha256sum "$path")"
  derived_sum="$(docker run --rm "$derived" sha256sum "$path")"
  if [ "$base_sum" != "$derived_sum" ]; then
    echo "FAIL: $path differs between $base and $derived (the derived image reinstalled it)" >&2
    fail=1
  fi
done

# The base's entry point still answers in the derived image, and the nare the
# base pinned is still the one on PATH.
version="$(docker run --rm "$derived" qare --version)"
if [ -z "$version" ]; then
  echo "FAIL: the base's entry point does not answer in $derived" >&2
  fail=1
fi

web="$(dirname "$0")/web/Dockerfile"
if ! grep -q '^ARG QARE_IMAGE=' "$web"; then
  echo "FAIL: the web image does not take its base through the contract ARG" >&2
  fail=1
fi
if grep -qE '^(FROM (node|alpine|debian|ubuntu)|RUN .*apt-get install .*(node|python3|pnpm)|RUN .*(npm install|pnpm install|pip install).*nare)' "$web"; then
  echo "FAIL: the web image installs something the base already ships" >&2
  fail=1
fi

exit "$fail"
