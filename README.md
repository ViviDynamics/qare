# qare

A QA agent harness. Given a pull request and the issue it closes, qare boots the
app before and after the change against stubbed services, checks every
acceptance criterion, and posts the evidence on the pull request: a
per-criterion table with screenshots, logs and traces, and a verdict decided by
code rather than by a model. Screenshots are also pushed to an orphan
`qa-assets` branch under a path naming the run, so the evidence comment's
screenshot links keep resolving after the run's artifact expires. It can also
check an app it did not boot, such as staging or a public site, when the
profile names a target instead of a boot recipe. The shortest way in is a
sentence:
`qare check "searching Wikipedia for Ada Lovelace shows her article" --profile examples/wikipedia/.qa`.

qare sits beside [nare](https://github.com/ViviDynamics/nare) in the Coordinare
project family: an orchestrator calls nare to develop and qare to QA. Other
agent harnesses can call qare the same way, through its CLI, GitHub Action, or
MCP server.

Anyone can re-run a verdict after the fact: `qare replay <dir>` recomputes it
from the run's stored `plan.json` and `result.json` in code alone, with no
model and no network, and says whether it is byte-identical with the verdict
the run judged. When it is not, it prints the criteria that moved, and names
the verifier when a downgrade only the model could make is why. It is the
audit that a published verdict still follows from the artifacts that claim it.

Concurrent runs never collide: each run boots its app under its own compose
project and on a host port allocated for that run alone, and `qare reap`
tears down the stacks a canceled or crashed run left running (#53). It takes
a run's project by name while other runs stay live, and sweeps every `qare-*`
project when no run is left working.

Every model call qare makes goes through nare. That rule, and the others that
hold for every change here, are in [CONSTITUTION.md](CONSTITUTION.md).

Status: design. See [docs/SPEC.md](docs/SPEC.md).

## Extending the images

Images are layered: a project starts from the base and adds what it needs. The
paths, entry point, user and tags a derived image can rely on are the image
extension contract in [docs/images.md](docs/images.md), and
[examples/derived-image](examples/derived-image) is a worked example that adds
a driver and a host tool.

## Licensing

qare is source-available under the
[Elastic License 2.0](LICENSE). You may run, modify, and self-host it,
including commercially. You may not offer it to third parties as a hosted or
managed service.

## Contributing

Discussions yes, issues and pull requests are maintainer-only. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the policy and the reasoning behind it,
and [SECURITY.md](SECURITY.md) for how to report a vulnerability.
