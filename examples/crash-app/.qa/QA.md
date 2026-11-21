# QA for crash-app

A service that never comes up. It exists so qare's own CI proves a boot
failure leaves what the run needs to explain it (#407): the service's log in
`<side>/services/web.log`, redacted, and a comment that names the service,
its exit code and its last lines, beside the name it looked up that no stub
declares.

- `web` looks up `db.crash-app.example`, prints that it cannot reach it, and
  exits 1.
