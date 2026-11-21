# QA for command-app

A page behind an HTTP server, booted from a start command in a stock image,
with no compose file (#379). It exists so qare's own CI runs the pipeline's
execute step against a command boot, and that path stays working.

- Health: `/up` answers 200 once the server is listening.
- The page at `/` carries the greeting `Hello-from-command`.
- There is no sign-in. The seed leaves `/tmp/seeded` inside the service.
- The `in-service` and `seeded` suites run inside the booted `app` service,
  through `docker compose exec` on the run's own compose project.
