qare repository QA profile (self-run target).

What this is: the profile qare's own self-run executes, so a pull request
that links flow criteria runs them for real instead of being refused for
want of a profile (#128). The repository has no app of its own to boot, so
the profile names a target (#122): the public site the examples use, checked
in place. qare boots nothing, stubs nothing, and compares nothing with a
base revision, because there is none.

What a check looks like: a flow's `open` takes a path on the target, which
resolves against the target URL, and the typed actions drive the browser.
Searching for an article and reading the results page, where the top entry's
snippet opens with the names that prove it is hers:

    - { action: open, url: /wiki/Main_Page }
    - { action: type, element: { role: searchbox, name: Search Wikipedia }, value: Ada Lovelace }
    - { action: click, element: { role: button, name: Search } }
    - { action: assert, text: Augusta Ada King }
    - { action: assert, text: Countess of Lovelace }

Search the way the example does: click the Search button rather than a
suggestion under the search box, because the suggestions are several links
with overlapping names and the run refuses an element it cannot resolve to
one.

Boundary: the target is the live site, so the run needs the network, and a
page that cannot be reached is reported unverified or blocked, never failed.
The checks drive a browser, so the run executes in the published web image
(#88): the profile names `flavour: web`, and the pipeline's execute step pulls
the flavour the profile names.

What qare is: a harness a repository points at its own pull requests. The
pipeline collects the criteria from the issue, the planner turns each one
into checks, the runner executes the plan, and the judge reads the evidence
against the criterion. The planner is a model: it plans well only when the
profile tells it the truth about what a check can do here.

What qare's own criteria are usually about, and how each is shown in real
development:

- A package's behaviour: its vitest tests, filtered to the behaviour.
- The CLI's behaviour: the built CLI driven with fixtures.
- The pipeline contract: the workflow's structural tests.
- A flow against a running site: the kind this profile's target covers.

What a self-run can and cannot show. The executing job runs the published
image against a raw checkout of the pull request: it installs and builds
nothing, and the image carries no test runner, no npm, no git and no jq.
Because of that:

- A criterion shown by a test suite is out of reach: the checkout has no
  node_modules and there is no test runner to invoke. Mark it unplannable
  naming the missing test runner instead of guessing an invocation that
  cannot start.
- The CLI's behaviour through this pull request's own build is out of reach
  for the same reason: nothing builds the checkout, and the image's own qare
  binary is the base revision's, which says nothing about the change.
- Evidence only a model-driven session can produce is out of reach: the
  executing job runs no model.
- A behaviour that needs Docker the check drives itself, several concurrent
  runners, or a clock the check controls is out of reach: the image has no
  Docker CLI, the job runs one runner, with its own clock.
- A check script that would need writing is out of reach: the profile declares
  no scripts of its own, and the image runs only files the checkout already
  carries. A criterion whose check would be a new script is unplannable
  naming the missing script, never a path that does not exist.

What a command check can genuinely show: structure on the paths the change
touches, read with the tools the image really has. The profile declares those
commands; prefer them over inventing invocations, fill every placeholder from
the criterion, and keep the check inside the declared run inputs.
