# Design: credentials in an operator-run service

Issue #315

## Scope

In: a decision record comparing credential placement, a precise OIDC trust
contract, a deployment and caller sketch, and ordered implementation issues.
Out: service code, a chart, a workflow migration, or changes to existing users.
This issue asks for a design only.

## Assumptions

- The existing Actions-secrets model stays supported for operators who accept
  its trust boundary; service mode is an additional choice.
- The service invokes nare as a separate process and executes no repository code.
- Initial service mode refuses fork pull requests; supporting them needs a
  separately reviewed trust and billing policy.
- Design validation is a review against the six issue criteria and GitHub's
  primary OIDC documentation, plus the repository's preflight and CI. There is
  no implementation for a runtime red/green test in this documentation change.

## Tasks

- [x] 1. Compare the two models and specify their trust boundaries.
- [x] 2. Specify identity verification, job separation, deployment and caller.
- [x] 3. File independently shippable implementation issues and link their order.
- [x] 4. Review all acceptance criteria, run preflight, and ship the design PR.

Independent review clarified the PR merge/head SHA distinction and required
an enforcing DNS-aware CNI for the chart, with installation probes. Neither
change exports credentials or executes repository code on the service.
