# Design review gate: evidence, reviewer prompt and checklist

Read with ship-issue Stage 2b. The code review reads the diff. This gate reads the
rendered screens, because a diff can pass every test and every code review while the
page it draws is scattered, clipped, contradictory or empty. That is how a whole run of
console work shipped "half baked": every PR passed CI and an independent code review, and
nobody looked at the page.

## When it applies

`design-gate touches` exits 0: the local diff touches a path in `VIVI_UI_PATHS` (UI
sources and styles, design specs and mockups, visual baselines). A spec-only change still
gets the gate, judged as a spec (`--kind spec`, no screenshots, allowed only when every
touched UI file is in `VIVI_UI_SPEC_PATHS`, the reviewer reads the
spec and its mockups). A change that touches no UI path has no design gate.

## 1. Builder evidence, before the first push

For every route the change touches, and for every overlay the change touches (a panel,
a popover, a dialog: open it with a route action, since the overlays are where the worst
problems hide):

- **After**: the worktree's UI, served on your own stack.
- **Before**: the same routes on the default branch (a detached worktree of
  `origin/<default>`; `--serve` it).
- **Widths** 1280 and 375. **Themes** light and dark.
- **States** where the page has them: populated, empty, loading, error. Empty usually
  needs a persona whose organization has no data; loading and error are simulated by
  `ui-evidence` at the network.
- **Real rendered pages** on your own stack (in ViviDynamics/elm: the
  `scripts/ci/worker_env.sh` slot, seeded). Fixture data only when a feature gate makes
  the real page impossible, and then say so (`design-gate record --fixtures "<why>"`, it
  goes into the PR body).

```bash
git worktree add --detach /tmp/before-<issue> origin/<default>
$S/checkpoint context <issue> --set extra_worktrees=/tmp/before-<issue>   # add any reviewer's, comma-separated
$S/ui-evidence <issue> --label before --routes routes.json --serve /tmp/before-<issue>
$S/ui-evidence <issue> --label after  --routes routes.json --serve "$PWD"
$S/ui-evidence dir <issue>          # where the shots and manifest.json are
```

Serve the worktree again once the before shots are taken, and remove the before
worktree when the gate is recorded. `cleanup` removes it after the merge if you forget,
but only when it is listed in `extra_worktrees`, and it unpublishes the evidence ref and
deletes the local shots then too.

`routes.json` is a JSON array; see `ui-evidence`'s header for the fields. Narrow a
loading or error route's `api` glob to the page's own data requests: blocking every API
call also blocks the app shell's bootstrap, and the shot shows the shell's boot screen
instead of the page. Example:

```json
[
  {"name": "usage", "path": "/usage"},
  {"name": "usage, empty org", "path": "/usage", "state": "empty", "as": "empty"},
  {"name": "usage, loading", "path": "/usage", "state": "loading", "api": "**/v1/console/usage**"},
  {"name": "usage, error", "path": "/usage", "state": "error", "api": "**/v1/console/usage**"},
  {"name": "usage, filters open", "path": "/usage", "actions": [{"click": "button:has-text('Filters')"}]},
  {"name": "usage, time range open", "path": "/usage", "actions": [{"click": "button:has-text('Last 30 days')"}]}
]
```

`ui-evidence` remembers which tree the stack serves: after `--label before --serve
<main checkout>`, the stack serves main until you `--serve` the worktree again, and an
after run without `--serve` would describe main (and `design-gate record` refuses it).
`record` also refuses a manifest with no shots or with failed ones, and before shots
whose head is not on the default branch.

Look at every shot yourself first and fix what is obviously wrong: the reviewer's
rounds are for what you could not see, not for what you did not look at. Read the
manifest's probes too: `horizontal_overflow`, `console_errors`, and `focus` (a focused
element that is not interactive, or a focus ring left on a closed overlay's trigger).

## 2. The Done-when evidence table

Every "Done when" item of the issue, mapped to the screenshot that shows it, or marked
not visual with the test that proves it. It goes to the reviewer and into the PR body.

```markdown
| Done when | Evidence |
| --- | --- |
| Time range, filters and export sit on one toolbar row | after/usage-1280-light.png, after/usage-375-dark.png |
| The filters panel overlays the page with a scrim and clips nothing | after/usage-filters-open-1280-dark.png |
| Export is disabled with no usage in range | not visual: console/test/usage-export.test.js "disables export when empty" |
```

An item with no evidence is not done.

## 3. Sibling pages

List the other pages that use the components the change touches (the same header, tile,
filter bar, empty state, table, pill), and shoot them too, at least 1280 light and 375
dark, as a third label or within the after set. Consistency is judged against them: a
component restyled on one page and left alone on its siblings is a finding.

## 4. The independent design reviewer

A separate agent, not you, in its own detached worktree at the head under review
(`git worktree add --detach <path> <head>`). Give it ONLY:

- the issue (number and full text), with its "Done when" list;
- the relevant design specs and mockups, from the repository's design system index
  (`VIVI_DESIGN_INDEX`): the paths, so it reads them itself;
- the screenshot directories (before, after, siblings) and the manifests;
- the Done-when evidence table.

Never your plan, your summary, the diff's rationale or what you think is fine. A
reviewer handed the author's reasoning returns it confirmed. Use the harness's own
subagent on a strong model (Claude Code: an Agent subagent, model opus; Codex: a separate
session). If the harness cannot start one, or the reviewer cannot read images, the gate
is unsatisfied: stop, never review it yourself under this name.

### Reviewer prompt template

```text
You are an independent design reviewer for issue #<N> in <repo>. You did not build this
change. Judge the rendered screens, not the code. Do not edit anything.

The issue:
<full issue text>

Design system: read <design index path> and the specs it links that apply here:
<paths>. Mockups: <paths, if any>.

Screenshots: before (the default branch) in <dir>/before, after (this change) in
<dir>/after, sibling pages using the same components in <dir>/<siblings>. Each directory
has a manifest.json listing route, state, width, theme and probes (horizontal_overflow,
console_errors, focus) for every shot. Shots are full-page, so they extend below the
900px (desktop) or 812px (phone) viewport; an element sized to the viewport height, such
as a sidebar, ends at that height in the image. That is the capture, not the layout.

Done-when evidence table:
<table>

OPEN AND LOOK AT EVERY IMAGE you cite (read the PNG files). A finding not tied to a
screenshot you looked at is not a finding. Compare after with before, and after with the
siblings. Work through the checklist below, item by item.

Separate what this change introduced, or its Done-when list owns, from problems already
present before it (visible the same in before/). Report both; label the pre-existing ones.

Report:
- Verdict: PASS or FAIL. FAIL if a Critical or Important finding that this change
  introduced, or that its Done-when list owns, is open.
- Findings, each: severity (Critical, Important, Minor), the screenshot file(s), what is
  wrong as a user would see it, the spec rule or sibling it breaks, and a suggested fix.
- For each Done-when row: met, not met, or not shown, with the screenshot.
- Any screenshot you needed and did not get (a state, a width, an overlay).

Severity: Critical = a Done-when item visibly not met, content clipped or unreadable,
an action that cannot be found or used, contradictory information, broken phone layout.
Important = a spec rule broken, inconsistency with sibling pages, a layout defect a user
notices (misalignment, stray row, detached popover, focus ring on a non-interactive
element), an empty state with no next step. Minor = polish.
```

### Checklist

1. **Done when.** Every item visibly met in the screenshots its row names. An item
   claimed but not visible is not met.
2. **Spec conformance**, against the design system specs:
   - tokens only: colours, type sizes, spacing, radius, elevation (no unbranded
     literal colours, no off-scale type, no browser default link blue);
   - page header anatomy: title, one purpose line, actions where the spec puts them,
     the same on every page that has a header;
   - one filled primary action per view, header and error states included; button
     sizes and order; no full-width buttons at desktop unless the spec says so;
     destructive actions styled as the spec says;
   - stat tiles: the tile component, one look everywhere, an odd count with no hole,
     labels in the content rules' case;
   - empty states: the component, a reason and a next step (an action or a link),
     never a bare sentence in a big card, never copy that points "above" or "below";
   - tables, filters, pills (one anatomy; text and colour agree), dates and times (the
     console's format, one time zone note), missing values (the spec's placeholder);
   - glossary and content rules: one word per concept, the same action named the same
     way everywhere, sentence case, no em dashes.
3. **Consistency with siblings.** The same component looks and behaves the same on the
   sibling pages; a component adopted on some pages and not others is a finding; the
   same control (export, filters, time range) sits in the same place on every page.
4. **Layout quality.**
   - Alignment: a shared left edge, no stray insets.
   - One toolbar row for a page's controls (time range, filters, then export at the
     right), not controls scattered over several rows with helper lines floating
     between them.
   - Overflow and clipping: nothing cut off mid-word, no horizontal scroll (see the
     manifest probe), long values wrap or truncate with a full value available.
   - Overlays: a panel or dialog overlays cleanly (scrim or reflow), never clips the
     page under it; a popover is anchored to its trigger, edges aligned, not floating
     over unrelated content.
   - Focus: rings only on interactive elements; focus returns to the trigger when an
     overlay closes and no ring is left behind on a mouse close; a selected state reads
     as selected, not as focus (no underline-plus-ring for "current").
   - Copy: no two captions that contradict each other (a card that says it covers the
     selected window next to a tile that ignores it), no garbled or doubled values
     ("0 Flagged 0"), no repeated explanations (the same note three times), no
     meaningless zero states ("0.0% failed (0 of 0)").
   - Dead space: no lone control in an empty band, no giant card around one sentence.
5. **Phone (375).** It reflows: no panning, controls reachable, tables reflow or
   scroll inside their card, overlays fit, toolbars stack in a sensible order.
6. **Light and dark.** Both legible, contrast holds, no element that only works in one
   theme, the same hierarchy in both.
7. **Before versus after.** Nothing that was right before is worse after. A regression
   the issue did not ask for is at least Important.
8. **Probes.** Every `horizontal_overflow: true`, console error, and non-interactive
   focused element in the manifests is explained or is a finding.

For a spec-only change (`--kind spec`), judge the spec: it resolves every case it raises
(odd counts, empty, loading, error, phone, dark), does not contradict the other specs,
gives rules a builder cannot misread into the layouts above, and its mockups agree with
its text.

## 5. Fix loop

- Critical and Important design findings this change introduced, or its Done-when list
  owns, are always fixed, at any round count.
- Pre-existing problems the reviewer reports (the same in before/) go in the PR body
  under `### Design review gate` as pre-existing, with the open issue that owns each
  where there is one, and in SHIP_RESULT `unresolved` for a human to triage where there
  is none. Never silently, and never fixed in passing beyond the issue's scope.
- After fixes, commit, take fresh `--label after` screenshots of the new head, and
  review again: a new round, with a new reviewer agent given only the inputs above plus
  the previous findings, asked to confirm each is fixed on the new shots and to look for
  anything the fixes broke.
- The same round budget as the code review (2); past it, review only what the fixes
  changed. Minor findings at your judgment.
- A finding you do not fix goes in the PR body under `### Design review gate` as
  unresolved, with why, and in SHIP_RESULT `unresolved`. Never silently.
- A Critical or Important finding you cannot fix (it needs an owner decision): stop with
  `unresolved`; the gate is not PASS, so prepush will not push it.

## 6. Recording

```bash
$S/design-gate record <issue> --verdict PASS --rounds <n>   # --kind spec for specs
$S/design-gate section <issue>                               # the header lines for the PR body
$S/ui-evidence publish <issue>                               # private repos: links for the owner
```

`record` refuses unless: the tree is clean; the after screenshots are all taken, of HEAD's
UI fingerprint, from a clean tree that is not the default branch; and the before
screenshots exist, all from a clean tree on `origin/<default>`. PR body section:

```markdown
### Design review gate
Design gate: independent
Verdict: PASS
Reviewed head: <sha>
UI fingerprint: <hex>
Kind: ui
Routes: /usage, /usage (filters open)
Viewports: 1280, 375
Themes: dark, light
Rounds: 2
Evidence: <ui-evidence publish markdown, or where the shots are>
- Critical, fixed: the filters panel clipped the page mid-word (after/usage-filters-open-1280-dark.png)
- Important, fixed: the time range popover floated away from its trigger (after/usage-time-range-open-1280-light.png)
- Minor, not fixed: <finding>, because <why>

| Done when | Evidence |
| --- | --- |
| ... | ... |
```

`prepush` refuses a UI-touching head without a PASS whose fingerprint is HEAD's; a later
commit that touches no UI file keeps it, any UI change makes it stale. `merge-verified`
refuses a UI-touching PR whose body lacks a PASS for its current UI.

## 7. Owner sign-off hold (opt-in)

Only the owner, or someone the owner asked, labels an issue or PR
`needs-owner-design-review` (`VIVI_DESIGN_HOLD_LABEL`). An agent never applies it. With
the label, `merge-verified` refuses until `VIVI_DESIGN_OWNER` comments on the PR with a
line that is exactly:

    Design approved: <the PR's UI fingerprint, all 16 characters>

Put the published screenshot table (`ui-evidence publish`) in the PR body and, on its own
line, the exact phrase the owner should post. Never post that phrase yourself, and never
edit or quote it in a comment of your own: where agents share the owner's GitHub account
the scripts cannot tell who typed it, so this rule is what keeps the sign-off the
owner's. The approval names the UI fingerprint, which the PR's own file list proves, so a
UI change after the approval changes the fingerprint and the owner approves again. (A held
PR that touches no UI path is approved by 7 or more characters of its head sha.) The hold,
like the whole gate, is off when `VIVI_UI_PATHS` is empty.
