# ADR-0013: a base with no profile is planned with the pull request's profile, read as data

Date: 2026-11-25
Status: accepted

## Context

The plan job holds the model key, so it checks out the base revision and
never the pull request's tree (constitution rule 7), and it read the profile
from that checkout. The pull request that onboards a repository is the one
that adds `.qa/`, so its base has none, and every such plan was made with no
profile: no declared suites, no app address (so no http check is offered),
no commands, no QA.md and no exploration. Execute and judge used the head's
profile, so the plan was made against a different profile from the one that
ran it. On the steward pilot (#431) the planner said "there is no http check
kind" and "the repository declares no suites" for a profile that declares
four suites and an http health check.

The onboarding pull request is the first run anyone sees.

judge, which also holds the model key, already reads the head's profile, as
data, from the `qa-profile` artifact execute uploads.

## Options

| Option | Why not, or why |
| --- | --- |
| Keep planning with no profile, and judge the planner on the next pull request | Every new repository's first run shows qare planning blind, and the planner's suite and http rules never reach an onboarding |
| Check out the head in the plan job | The job that holds the key would hold the pull request's whole tree, with its scripts, in the planner's container. Rule 7 exists to stop exactly this |
| Read the head's profile as data, with nothing in it started | The profile is configuration: YAML, Markdown and fixture files. What in it can run in the plan step is small and known: host MCP servers name a command, and `explore: base` boots the base. Both can be left off |

## Decision

When the base revision has no profile at the caller's `profile` path, collect
exports the head's profile directory from git objects (regular files only:
no links, no submodules, no path that leaves the directory) as the
`qa-pr-profile` artifact. collect holds the GitHub token, and the export
reads git objects alone: nothing of the pull request is checked out, built or
run.

The plan job downloads it to the profile's path in its base checkout, where
nothing is, after exploring has been decided from the base, and hands it to
`qare plan --pr-profile`. That flag loads the profile like `--profile` and
then:

- starts none of its host MCP servers, because a server's `command` would run
  beside the key. A driver mapping is kept, because it is what the plan's
  flows may do in execute.
- refuses `--explore`, because exploring boots the base, which the profile
  does not describe.
- refuses `--profile` beside it.

The plan records which profile it read (`profileSource`), judge copies it onto
the result (`planProfile`), and the comment and the plan job's summary say it.

The pipeline passes the head's profile only through `--pr-profile`. qare's
CLI ignores a flag it does not know, so a pinned image older than this
change plans with no profile, as it did before, instead of reading the
profile as its own with its servers started. The summary says so when it
happens.

## Consequences

- An onboarding pull request is planned with the suites, address, commands
  and QA.md its own run uses.
- The pull request's QA.md and suite commands reach the planner's prompt.
  That is no new kind of input: the planner already reads the pull request's
  diff, which carries the same files, and judge already reads the profile.
  The model's output is still only a plan, which qare validates, and the
  verdict is still computed from executed results (rule 3).
- A profile's redaction patterns are compiled in the plan step as they are in
  execute and judge. A pattern is matched against text; it runs nothing.
- With a profile at the base, the plan job does what it did before.
- Exploring the head still needs the sandbox split of #87.
