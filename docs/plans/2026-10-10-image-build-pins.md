# Pin image build inputs

Issue #333

## Scope

Pin Python builder/runtime bases and default flavour core bases by digest,
verify the named nare wheel before pip installs it, use the workspace's
hashed pnpm declaration, and build release flavours from that run's core
digest. Local CI can still supply its explicit local core image.

This verifies these build inputs. It does not lock every apt or pip
transitive dependency or replace release immutability settings.

## Assumptions

- Docker's manifest digest is the immutable base identifier.
- The nare release wheel hash is independently checked against downloaded
  bytes before it is committed.
- Derived releases receive the core build's digest, not a tag resolved later.

## Tasks

- [x] Add failing base, wheel-hash, package-manager and release handoff tests.
- [x] Pin verified inputs and fail before installing a mismatched wheel.
- [x] Build core and web locally and inspect their runtime records.
- [ ] Final rebase/stamp, full preflight, independent review, Copilot and QA.
- [ ] Verify main CI, exact tag and core/web publication.
