# qare

A QA agent harness. Given a pull request and the issue it closes, qare boots the
app before and after the change against stubbed services, checks every
acceptance criterion, and posts the evidence on the pull request: a
per-criterion table with screenshots, logs and traces, and a verdict decided by
code rather than by a model. It can also check an app it did not boot, such as
staging or a public site, when the profile names a target instead of a boot
recipe. The shortest way in is a sentence:
`qare check "searching Wikipedia for Ada Lovelace shows her article" --profile examples/wikipedia/.qa`.

qare sits beside [nare](https://github.com/ViviDynamics/nare) in the Coordinare
project family: an orchestrator calls nare to develop and qare to QA. Other
agent harnesses can call qare the same way, through its CLI, GitHub Action, or
MCP server.

Every model call qare makes goes through nare. That rule, and the others that
hold for every change here, are in [CONSTITUTION.md](CONSTITUTION.md).

Status: design. See [docs/SPEC.md](docs/SPEC.md).

## Licensing

qare is source-available under the
[Elastic License 2.0](LICENSE). You may run, modify, and self-host it,
including commercially. You may not offer it to third parties as a hosted or
managed service.

## Contributing

Discussions yes, issues and pull requests are maintainer-only. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the policy and the reasoning behind it,
and [SECURITY.md](SECURITY.md) for how to report a vulnerability.
