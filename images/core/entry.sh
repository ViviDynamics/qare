#!/bin/sh
# The core image's entry point: the contract fixes its name and path
# (docs/images.md), so a derived image can wrap it and still exec the
# original. It execs the workspace CLI; the shell wrapper keeps the base's
# signal handling intact.
exec node /opt/qare/lib/packages/cli/dist/index.js "$@"
