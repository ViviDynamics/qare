# An open qa-failure issue is relabelled when it becomes a regression, and a refused push of the record of passes is retried only when the branch moved

Issue #304

## Scope

In:

- A run that classifies a criterion as a regression, where the open (or hand-closed) issue for its fingerprint carries `qa-failure`, comments on it with the last pass (run, revision, time) and the pull requests since, then gives it `qa-regression`, takes `qa-failure` off and retitles it.
- `pushMainPasses` tries a refused push again only when the branch head is no longer the commit the push was built on. A refusal with the head unchanged fails on the first attempt with GitHub's own message.
- The compare requests one `main-findings` run makes while classifying (`earlierPasses`) are bounded by a fixed budget. A run that would pass it stops by name before any request is made and files nothing.

Out:

- The retry rule of `commitOntoBranch` (screenshots and metrics): the issue names only the record of passes, and a screenshot push carries no state that a retry could corrupt.
- The compare requests of recording passes: the issue's comment names classifying only.

## Assumptions

- The comment that turns an issue into a regression mentions the people blame names, like a new regression issue does. It is the first time a change is blamed for it, so nobody has been notified yet. A later update to the same issue still mentions nobody.
- Writes go comment first, then labels: a run that fails half-way leaves an issue still labelled `qa-failure`, which the next run relabels again, so nothing is lost.
- The budget is 20 compare requests, the same order as the other bounds of the step (20 pull requests of a range).

## Tasks

- [x] 1. Push retry: a refusal with the head unchanged fails on the first attempt with GitHub's message, and a race still retries.
- [x] 2. Relabel: a `qa-failure` issue that becomes a regression gains `qa-regression`, loses `qa-failure`, and the comment names the last pass and the pull requests since; the dry run reports it and writes nothing.
- [x] 3. Compare budget: a run whose failed criteria name more recorded revisions than the budget stops by name, with no compare request and no write.
