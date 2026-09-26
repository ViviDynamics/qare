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
