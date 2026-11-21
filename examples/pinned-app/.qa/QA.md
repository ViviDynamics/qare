# QA for pinned-app

A stack written for a daemon that answers no embedded DNS, booted with
compose. Its default network has a subnet of its own, the database and the
billing stub are pinned to addresses on it, and the app declares no network
and finds both through `extra_hosts`. It exists so qare's own CI proves a
contained stack keeps every network its services were on (#408), and that
the relay and the resolver reach services by the addresses the run reads
from the daemon.

- Health: `/up` answers 200 once the app has tried the database and the stub.
- `/db.txt`: what the database answered at its pinned address, or `unreached`.
- `/billing.txt`: what the billing stub answered by the vendor's host name, or `unreached`.
- `/seeded.txt`: what the seed fetched from the database.
