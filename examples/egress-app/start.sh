#!/bin/sh
# What the app reaches for before it says it is up (#382). Each outcome is a
# page the plan's checks read through the port the run published.

# The declared stub, by the vendor's own host name: the run's resolver
# answers it with the stub service's address. The stub may still be
# starting, so it is asked a few times.
billing=unreached
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if wget -q -T 3 -O /tmp/billing http://api.billing-vendor.example/; then
    billing="$(cat /tmp/billing)"
    break
  fi
  sleep 1
done
echo "$billing" > /site/billing.txt

# A vendor no stub declares: the run's resolver records the name and
# answers that there is no such host.
if wget -q -T 3 -O /dev/null http://api.undeclared-vendor.example/ 2>/dev/null; then
  echo reached > /site/undeclared.txt
else
  echo blocked > /site/undeclared.txt
fi

# A literal address names no host: the internal network has no route to it.
if wget -q -T 3 -O /dev/null http://1.1.1.1/ 2>/dev/null; then
  echo reached > /site/address.txt
else
  echo blocked > /site/address.txt
fi

echo ok > /site/up
exec httpd -f -p 3000 -h /site
