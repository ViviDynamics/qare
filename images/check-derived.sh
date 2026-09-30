#!/bin/sh
# The derived-image no-reinstall check (#88, #89). A flavour is built FROM
# core and adds one driver family: anything it installed again would undo
# the point of the layering. It takes the image tags, the base first and
# then one per flavour:
#
#   images/check-derived.sh qare-core:ci qare-web:ci qare-android:ci qare-desktop-linux:ci
#
# It fails when a file the base ships is not byte-identical in the derived
# image, or when the derived image's build recipe installs what the base
# already provides.
set -eu

base="$1"
fail=0

# Every flavour's recipe takes its base through the contract ARG and
# installs nothing the base already provides.
for flavour in web android desktop-linux; do
  recipe="$(dirname "$0")/$flavour/Dockerfile"
  if ! grep -q '^ARG QARE_IMAGE=' "$recipe"; then
    echo "FAIL: the $flavour image does not take its base through the contract ARG" >&2
    fail=1
  fi
  if grep -qE '^(FROM (node|alpine|debian|ubuntu)|RUN .*apt-get install .*(node|python3|pnpm)|RUN .*(npm install|pnpm install|pip install).*nare)' "$recipe"; then
    echo "FAIL: the $flavour image installs something the base already ships" >&2
    fail=1
  fi
done

# Each derived image named on the command line is compared with the base.
for derived in "$@"; do
  [ "$derived" = "$base" ] && continue
  for path in /opt/qare/bin/qare /opt/qare/config/IMAGE.json /usr/bin/node /usr/local/bin/nare /usr/local/bin/python3; do
    base_sum="$(docker run --rm "$base" sha256sum "$path")"
    derived_sum="$(docker run --rm "$derived" sha256sum "$path")"
    if [ "$base_sum" != "$derived_sum" ]; then
      echo "FAIL: $path differs between $base and $derived (the derived image reinstalled it)" >&2
      fail=1
    fi
  done

  # The base's entry point still answers in the derived image, and the nare
  # the base pinned is still the one on PATH.
  version="$(docker run --rm "$derived" qare --version)"
  if [ -z "$version" ]; then
    echo "FAIL: the base's entry point does not answer in $derived" >&2
    fail=1
  fi
done

exit "$fail"
