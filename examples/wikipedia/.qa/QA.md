Wikipedia QA profile (example target).

What this is: a public site qare did not boot. The profile names the site and
a page that proves it is up, and nothing else; qare boots nothing, stubs
nothing, and compares nothing with a base revision, because there is none.

What a check looks like: a command check reaches the site through
`{{run.target_url}}`, and a flow's `open` takes a path on the site, which
resolves against the target URL. Searching for an article:

    - { action: open, url: /wiki/Main_Page }
    - { action: type, element: { role: searchbox, name: Search Wikipedia }, value: Ada Lovelace }
    - { action: click, element: { role: button, name: Search } }
    - { action: assert, text: Countess of Lovelace }

Boundary: this example runs against the live site, so it needs the network,
and the in-repo tests exercise the same profile shape against a local server
instead.
