# ADR-0010: an operator service may hold the model key and GitHub identity

Date: 2026-10-09
Status: accepted as a build direction by issue #315; service mode is not implemented

## Context and options

Today the caller hands Actions a model key and optionally a GitHub App key or
personal access token. execute holds none of them, and the credential-holding
jobs run trusted qare code. A person who can alter a workflow that receives
those secrets can still ask it to disclose them. Actions and images used by
those jobs are also in the credential trust boundary.

| Model | Protects against | Remaining trust and setup cost |
| --- | --- | --- |
| Secrets in Actions, as today | Repository code in execute has no model key or posting identity. Separate disposable machines prevent a previous execute job from modifying a later credential-holding job. | A modified credential-holding workflow, action or image can read its job's secrets. The operator configures repository secrets and runner isolation; GitHub runs the orchestration. There is no server to operate. |
| Credentials in an operator-run service | Actions receives no model key, App private key, PAT or posting token. An unapproved workflow cannot request service work; approved jobs receive only bounded run data. A compromised runner cannot extract the service's credentials. | The operator trusts the service image, nare, its cluster and secret store, GitHub's identity issuer/API, and the model endpoint. The operator runs TLS, storage, upgrades, monitoring and capacity, and approves workflow versions. An authorized runner can still forge evidence, abuse its allowed run budget, or disclose data it receives. |

## Decision

Add an opt-in service mode. Keep the Actions-secrets model supported for
small installations and operators whose Actions administration and disposable
runner boundary meet their needs. Neither mode silently falls back to the
other: an unavailable service or failed identity check stops the run with a
named outcome. Existing callers and their secrets continue to work.

The service owns collect, plan, verify, code-computed judging, GitHub posting,
reporting, advisory replies, requeue and the corresponding main-lane work.
Every model call remains a separate nare process, consuming its typed events
and sessions. Models can remove support for a pass; only qare code computes
verdicts. Criteria still change through reviewed pull requests.

The service **never executes repository code**: no checkout hooks, dependency
installation, build, compose, suites, shell commands, profile-supplied MCP
servers or browser visit to the application. Profiles, diffs, plans and
evidence are untrusted bounded data. The service's nare tools are restricted
to reading bounded supplied data; a profile cannot add tools or transports.
Features that require live exploration remain in a disposable Actions job
behind a data interface, or are refused until that interface ships. A missing
generic nare capability becomes an issue on nare, not a second model loop.

## Identity verification contract

This is a proposed contract to implement, not a claim that today's pipeline
already performs these checks. GitHub documents distinct caller and reusable
workflow claims in its [OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)
and [reusable-workflow guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows).
The rules below are qare's policy for those claims.

The only public service endpoint is `https://qa.example.org/v1/run`. It
accepts POST operations `start`, `status`, `result`, and `finish` with a GitHub
OIDC bearer token. It returns run data, never credentials. For every request:

1. Validate the JWT signature using GitHub's fixed
   [issuer and JWKS](https://token.actions.githubusercontent.com/.well-known/openid-configuration).
   Permit RS256 only, require `kid`, and never fetch a key from a URL in the
   token. Cache keys with bounded expiry, refresh once on an unknown key,
   and refuse when verification cannot complete. Require exact `iss`
   `https://token.actions.githubusercontent.com` and exact `aud`
   `https://qa.example.org/v1/run`. Check `exp`, `nbf`, and `iat` with at most
   30 seconds of clock skew, a maximum five-minute token age, and nonempty
   `jti`. Never log the bearer token.
2. Match `repository_id` and `repository_owner_id` to an operator-enrolled
   repository and owner. Check `repository`, `repository_owner` and
   `repository_visibility` against that enrollment as well. A rename or
   transfer requires a policy update. Require `sub` to match the enrolled
   subject template and the event/ref; do not authorize from a repository
   name prefix. Enrollment records the repository's actual subject format,
   including legacy, immutable-ID or explicitly customized subjects.
3. Require `job_workflow_ref` to be exactly
   `ViviDynamics/qare/.github/workflows/service-pipeline.yml@<approved full SHA>`
   and `job_workflow_sha` to equal that SHA. This identifies a release by an
   immutable commit, not by resolving a tag during a request. The operator
   approves the release's workflow and image digests together. Inputs cannot
   override the qare code revision or its images. A caller using a tag is
   refused even if it currently resolves to an approved SHA, so moving a tag
   cannot change an authorized release.
4. Require `workflow_ref` to name the enrolled repository and exact caller
   path, with a ref permitted for the event. Require a full `workflow_sha`;
   fetch that caller file **at that SHA** through the GitHub API and compare
   the SHA-256 of its exact bytes with an operator-approved caller digest.
   Do not fetch it from today's default branch or normalize its YAML. The
   commit can change as application changes land; unchanged caller bytes
   remain authorized. Editing even one caller byte is refused until an
   operator approves the new digest outside that run. No request may enroll
   its own digest. Nested callers are unsupported initially.
5. Require `event_name`, `ref`, `sha`, `run_id`, `run_attempt`, and
   `runner_environment`, and cross-check them with GitHub's API record for
   that repository's run and its jobs. Require an active run/attempt and a
   job belonging to it. Revision comparisons are event-specific as below;
   a PR merge SHA is not compared directly with the run API's head SHA.
   `check_run_id` binds the authenticated job to its
   permitted operation in the approved workflow: `service_start` may start
   a session and poll `status` while its plan is prepared;
   `service_finish` may submit `result` once execution has ended, call
   `finish` to request judging/reporting, and poll `status`. A result is
   accepted only in the issued-plan phase and finish only after a result
   or independently verified execution failure. execute receives no OIDC permission.
   Initially require `runner_environment: github-hosted`. Never trust a
   body-supplied repository, PR number, revision or artifact URL instead.
6. Initially permit only same-repository `pull_request` and `push` to the
   enrolled default branch. For a PR require the `refs/pull/<number>/merge`
   ref, matching `base_ref` and `head_ref`, and resolve its head and base
   SHAs through the run/PR API records. GitHub's
   [PR event contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
   makes the signed `sha` the merge commit, while the run API's `head_sha`
   identifies the PR head. Fetch the merge commit by that signed SHA through
   the Git Database API, require exactly two parents, and match the second
   parent to the run-bound PR head. The first parent is the base revision
   for this run; verify it belongs to the enrolled base branch's history.
   Freeze merge, head and base SHAs in the session instead of replacing them
   with a later PR API response. At start and finish, refuse a changed PR
   head or an API record inconsistent with these frozen identities. On a
   push, require signed `sha` to equal the run's `head_sha` exactly and use
   that frozen revision. A PR whose head repository differs
   from the enrolled repository is refused, regardless of actor. Bind the
   session to the exact run attempt and revisions; a new head needs a new
   session. Refuse `pull_request_target`, fork runs, `dynamic`, comments,
   dispatch and schedule until their separate event contracts ship.
7. Consume each `jti` once until expiry. A network retry obtains a fresh
   token and uses the same operation idempotency key. Persist run identity,
   allowed operation, artifact digests and monotonic phase transitions.
   Different attempts never share result slots. Rate-limit by repository
   and cap model usage, bytes and run duration in operator policy. Refuse
   missing claims, unknown operations, mismatched data and stale sessions.

OIDC proves which approved job is asking, not the truth of evidence produced
by untrusted code. The service independently fetches the issue and reviewed
criteria, accepts only a schema-valid harness result for its issued plan,
and verifies run/attempt, revision, artifact identity and digest. A model's
claim cannot create evidence. Full compromise of the execute machine can
still forge harness files; removing credentials does not solve attestation.

### Fork pull requests

A fork receives a named `service-identity-refused: fork pull request` result
and no plan, model spend, service upload capability or service-produced pass.
The Actions bridge records that outcome in the job summary; the service may
publish a neutral/skipped check after independently identifying the PR.
Missing or refused evidence never becomes green proof. Maintainers can use
ordinary CI or move reviewed changes to an enrolled branch. Fork support is
an explicit later policy decision, not `pull_request_target` plus a checkout.

## What stays in Actions

| Job | Work and authority |
| --- | --- |
| `service_start` | Pinned bridge requests OIDC, asks for a plan and downloads bounded input artifacts. It runs no repository code and holds no model key or GitHub posting identity. |
| `execute` / `main_execute` | Runs repository code, app boot and checks on a disposable machine. It has `permissions: {}`, no OIDC, no checkout credential, and no model or GitHub token. |
| `service_finish` | On a separate disposable machine, pinned bridge requests OIDC, submits the harness result, and polls for a service-computed outcome. It runs no repository code and holds no posting identity. Runs even on execute failure to report that failure. |

Actions supplies transient artifact/runtime capabilities for its own
transport, which are not model or GitHub posting credentials. Restrict these
to the run and never return a GitHub App token to a job. The service fetches
source archives with its own read-scoped App token and supplies them as run
data, so execute does not use authenticated checkout. Neither source archive
nor evidence extraction follows symlinks, writes outside its destination, or
executes archive contents on the service. Limit decompressed size and file
count. Source/build data and evidence cannot choose a network destination.

The first build supports the PR lane and simple main-lane runs. Moving
advisory/requeue and scheduled main runs needs event-specific identity work;
until it ships, service mode refuses those features by name. Existing
Actions mode keeps them. Containment declarations, runner-pool evidence and
outbound-control findings remain in evidence in either mode.

## Deployment and caller

Ship a versioned Helm chart with a service image pinned by digest, one HTTPS
Ingress to `/v1/run`, and an internal worker/queue. The default deployment
is one replica with durable bounded run/idempotency storage on a PVC;
multiple replicas need a shared transactional store before they are allowed.
The worker image includes the released qare and nare binaries. No Docker
socket, host mounts, privileged pod or cluster API access is needed.
Disable service-account-token automount, run as a non-root user, make the
root filesystem read-only and give each nare process a bounded temporary
directory. No repository workload is ever scheduled in this pod or on its
node through the service.

Operator-managed Kubernetes Secrets (or external-secret references) hold
the model key, GitHub App private key, and TLS key if the Ingress does not
terminate managed TLS. App ID and installation/repository IDs are config,
not secret. Service mode initially requires a GitHub App, scoped per
repository with Actions read, Contents read/write, Issues read/write,
Pull requests read/write, Checks read/write and Metadata read. It mints
short-lived tokens narrowed to each operation. It requires neither a PAT
nor repository Actions secrets. Credentials never enter responses, evidence
or logs; rotation changes secret references and restarts workers gracefully.

Chart values configure the endpoint/audience, repository enrollments,
caller hashes and allowed subjects/events, approved pipeline SHAs and image
digests, model name/provider through nare, limits, retention and storage.
The supported chart initially requires an enforcing Cilium installation
with [DNS-aware egress rules](https://docs.cilium.io/en/stable/security/dns/).
Ordinary Kubernetes NetworkPolicy cannot select domain names, and requires
an [enforcing network plugin](https://kubernetes.io/docs/concepts/services-networking/network-policies/#prerequisites).
The chart installs deny-by-default Cilium policies allowing cluster DNS,
GitHub API/OIDC, the configured model endpoint and internal storage. Its
versioned GitHub host manifest includes `api.github.com`,
`token.actions.githubusercontent.com`, `codeload.github.com`, and approved
GitHub artifact redirect hosts, including the regional Actions storage
hosts needed by the supported transport. Redirects are revalidated at every
hop against that manifest; missing destinations stop transport, and no
profile or API-returned URL widens the policy. Enrollment can approve an
explicit transport host update, outside a requesting run.

Installation refuses missing Cilium policy CRDs or an unsupported CNI setup;
chart acceptance probes from the service pod prove required hosts reachable
and undeclared hosts denied before enabling workers. Startup requires the
operator's successful installation verification record and a matching policy
digest; configuration alone is not proof that a plugin enforces it. Operators
rerun probes after CNI/policy changes. There is no permissive fallback for a
cluster without this prerequisite. The service never fetches a URL supplied
by a profile, model or result. Operators monitor refusal codes, queue age, model usage and
posting failures, back up enrollment/run state, prune evidence by retention,
and upgrade with explicit release/caller approval. If GitHub, nare or storage
is unavailable, the run stops and never publishes a pass. GitHub posting is
idempotent and retried without repeating paid model work.

The proposed caller is shorter than today's documented caller and grants no
GitHub write permission. `<approved-40-character-SHA>` is replaced with the
operator-approved service release; it is not a tag and this workflow is not
available until the build plan lands. The model/profile defaults come from
enrollment; optional profile input must be an enrolled path.

```yaml
name: QARE
on:
  pull_request:
jobs:
  qare:
    permissions:
      id-token: write
    uses: ViviDynamics/qare/.github/workflows/service-pipeline.yml@<approved-40-character-SHA>
    with:
      service-url: https://qa.example.org/v1/run
```

Enrollment is the extra setup outside the caller: install the App, deploy
the chart with its secret references, approve the release and caller digest,
then switch callers. GitHub's `id-token: write` permits minting an identity
token; it does not grant the job a GitHub write token. The reusable workflow
restricts that permission to the two bridge jobs. The endpoint is fixed by
enrollment/release policy; redirects and alternate destinations are refused.

## Acceptance and limits

This record chooses where credentials live; it does not change rule 7 or
claim that a Docker socket makes repository code safe. The service's own
dependencies remain trusted, and an approved workflow can request work
within policy. A GitHub issuer compromise or a compromised service can break
that boundary. No cloud account, production deployment, secret value or
billing commitment is selected by this design. Self-hosted service-mode
bridges and fork processing require their own reviewed extensions.

## Ordered build plan

Each issue will carry its own tests and can merge while service mode remains
unavailable. Enable the mode only after the trust, transport and deployment
contracts have all passed; no intermediate PR exports service credentials.

1. [#316](https://github.com/ViviDynamics/qare/issues/316): identity verifier and
   enrollment policy, with no model or posting side effects.
2. [#317](https://github.com/ViviDynamics/qare/issues/317): persistent run protocol
   and replay/idempotency enforcement. Depends on #316.
3. [#318](https://github.com/ViviDynamics/qare/issues/318): service collect/plan
   worker using nare and bounded data only. Depends on #316 and #317.
4. [#319](https://github.com/ViviDynamics/qare/issues/319): credential-free Actions
   execution and bounded artifact transport. Depends on #316 through #318.
5. [#320](https://github.com/ViviDynamics/qare/issues/320): service verification,
   judging and GitHub posting, including failure reporting. Depends on #319.
6. [#321](https://github.com/ViviDynamics/qare/issues/321): Helm packaging,
   operator enrollment/rotation, and end-to-end opt-in rollout. Depends on
   #316 through #320.
7. [#322](https://github.com/ViviDynamics/qare/issues/322): additional service
   event contracts for main schedules, advisory and requeue. Depends on #321.
