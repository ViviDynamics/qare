Pilot admin console QA profile (example).

What this app is: a Rails admin console for back-office operations.

What matters: payouts land correctly, the ledger stays accurate, and
authentication boundaries hold — admins see admin views, non-admins do not.

Page inventory (what the visual and flow checks cover): the payouts index,
the ledger export view, and the user-roles management screen — in both
themes at 1440 and 390 per config.yml.

How to log in: seed users come from fixtures/users.yml; sign in with the
admin fixture user for the admin role (see app.login in config.yml). The
admin user has two-factor sign-in enabled: the QA profile seeds a known
test-only TOTP secret through `bin/rails db:seed:qa`, and a plan proves the
second factor with a `totp` flow action, which types the code the harness
generates from that secret. Do not disable the second factor for QA — seed
the secret instead, so the login qare exercises is the login a person
performs.

Boundary: this in-repo example validates profile structure only. The
pilot-repo PR run — a full evidence comment with zero blocked egress —
needs the real compose stack and stub services wired in that repository.
