#!/bin/sh
# The profile's seed (#408), run inside the app once it is up: the data
# comes from the database at its pinned address, as the app's own would.
set -e
wget -q -T 5 -O /site/seeded.txt http://db/seed.txt
