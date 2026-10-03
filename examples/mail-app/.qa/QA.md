# QA for mail-app

An app that sends mail, booted with compose beside a Mailpit catcher. It
exists so qare's own CI proves a criterion about a sent message from a real
message, read from a real catcher (#65).

- Health: `/up` answers 200 once the app is listening and the catcher is
  ready to receive.
- `/signup?email=<address>` sends a message with the subject
  `Confirm your account` to that address. The body carries a link to
  `/confirm?account=<n>` and a one-time code.
- The link confirms the account once. A second visit answers 404.
- Mail is read from the catcher, which the app serves under `/mailpit`.
  Sign up with `{{run.mail_address}}`, so each run waits at its own address.
- There is no sign-in and nothing to seed.
