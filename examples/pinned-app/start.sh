#!/bin/sh
# What the app reaches for before it says it is up (#408). Each outcome is a
# page the plan's checks read through the port the run published.

# The database, by the pinned address extra_hosts gives its name. Only the
# default network carries it, so this is unreached if the app lost it.
db=unreached
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if wget -q -T 3 -O /tmp/db http://db/ready; then
    db="$(cat /tmp/db)"
    break
  fi
  sleep 1
done
echo "$db" > /site/db.txt

# The declared stub, by the vendor's own host name: the run's resolver
# answers it with the address the run read for the stub service.
billing=unreached
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if wget -q -T 3 -O /tmp/billing http://api.billing-vendor.example/; then
    billing="$(cat /tmp/billing)"
    break
  fi
  sleep 1
done
echo "$billing" > /site/billing.txt

echo ok > /site/up
exec httpd -f -p 3000 -h /site
