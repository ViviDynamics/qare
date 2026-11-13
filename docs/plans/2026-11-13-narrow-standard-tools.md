# Narrow standard interpreter command forms

Issue #309. The maintainer approved narrowing after the recorded command-form count.

## Scope

Constrain model-written command checks at plan validation. Reject inline code,
module/preload options and stdin interpreter execution; require a repository-relative
script and enforce declared run inputs when supplied. Remove nare from the standard
tools while retaining explicit profile declarations. Preserve bare version probes:
they execute no plan-supplied code. Direct authored jobs and profile suites keep
their existing execution contract. No containment or credential policy changes.

## Assumptions

- `node -- script.mjs` and `python3 -- script.py` are script forms.
- Arguments after the script are script data, including strings that resemble flags.
- A caller without a declared input list keeps its existing repository-relative input
  contract; a supplied list is authoritative. A script must not escape the repository.
- An explicit profile declaration does not bypass interpreter option restrictions.
- Bare `--version`, Node `-v`, and Python `-V` remain harmless capability probes.

## Tasks

- [x] Add failing behavior tests for forbidden interpreter forms, allowed scripts,
  undeclared paths, nare enrollment, and the correction round.
- [x] Add plan validation and prompt guidance, retaining failure accounting and
  the bounded correction loop.
- [x] Reconcile standard-tool fixtures and document the narrower rule beside ADR-0007.
Validation and shipping: run full preflight, review and guards, then ship through current-head CI. The PR and local ship checkpoint record those results.
