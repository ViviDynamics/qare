# QA for compose-app

A page behind an HTTP server, booted with compose from `compose.yaml`. It
exists so qare's own CI runs the pipeline's execute step against an app that
has to be booted, and that path stays working (#209).

- Health: `/up` answers 200 once the server is listening.
- The page at `/` carries the greeting `Hello-from-compose`.
- There is no sign-in and nothing to seed.
- The `in-service` suite runs inside the booted `web` service, through
  `docker compose exec` on the run's own compose project.
