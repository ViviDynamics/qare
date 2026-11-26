# Disclosure guard: detail

Read by ship-issue before every push, through `$S/prepush`. This is the detail behind
its one-line rule.

A public repository publishes everything pushed to it, forever: history rewrites do not
reach clones, caches or pull request refs. `$S/prepush` runs
`$S/disclosure-guard` on the local diff with the draft PR body (or the PR's body once it
exists). On a public repository it blocks added lines, file paths, commit messages and PR body
text that carry a private IPv4 address, a literal `*.svc.cluster.local` name, a personal
home directory, or any term from the maintainers' private list.

- `clean` or `not_public`: push.
- `private_terms: false` on a public repository: the private list is missing on this
  machine. Stop with `unresolved: disclosure terms unavailable`; never push unchecked.
- A `private_term` hit: remove it. It cannot be justified. Raw evidence from live
  infrastructure (spend logs, provider evidence, inventories, probe output, runbooks,
  client and key lists) belongs in a private repository; a public report carries only
  aggregates and placeholders.
- A generic hit that is genuinely not a real host or person (for example a made-up
  address in a parser fixture): name the file and why under `### Disclosure review` in
  the PR body, which makes it `justified`.
- Anything else: stop with `unresolved: disclosure blocked`.

The output names file, line and kind only, never the matched text, because Actions logs
on a public repository are public. Do not paste matched text into comments either.
