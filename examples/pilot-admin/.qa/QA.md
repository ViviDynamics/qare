Pilot admin console QA profile (example).

What this app is: a Rails admin console for back-office operations.

What matters: payouts land correctly, the ledger stays accurate, and
authentication boundaries hold — admins see admin views, non-admins do not.

How to log in: seed users come from fixtures/users.yml; sign in with the
admin fixture user for the admin role (see app.login in config.yml).

Boundary: this in-repo example validates profile structure only. The
pilot-repo PR run — a full evidence comment with zero blocked egress —
needs the real compose stack and stub services wired in that repository.
