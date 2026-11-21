# Containment drops a service's implicit default network, so a stack with static addresses cannot boot

Issue #408

## Scope
In: the containment override keeps every network a service had (the implicit `default` included) and adds `qare-contained`; the relay and the resolver reach services by addresses the run reads from the daemon at boot, never by name; a containment the run cannot finish is taken down and the stack boots uncontained with the reason; `examples/pinned-app` and its CI boot.
Out: service logs in evidence (#407), a separate issue.

## Assumptions
- `compose config --format json` lists a service's networks by key, with the implicit default as `"default": null`; a service it lists with no networks is on `default`.
- An empty mapping per network key, merged by compose over the stack's own, keeps `ipv4_address` and every other setting.
- The daemon reports each container's address on `<project>_qare-contained` through `docker inspect`, also when it answers no embedded DNS.
- The sink is handed stub addresses by `compose exec` of `qare cell egress-dns-map`, which writes a file on a tmpfs in the sink's own container; nothing of the stack shares that file system.
- The stub services start before the app, so the sink knows their addresses before anything dials them. The relay starts once the app is up, the first moment its address exists.
- An address the run cannot read or hand over follows #382's path: reported uncontained with the reason, after the half contained stack is taken down. A stack that cannot be taken down blocks the boot.
- CI cannot run a daemon without embedded DNS. The address path is proven by unit tests (the sink answers from the map where every name lookup fails, the relay dials an address) and by reading the live CI stack: the relay's forwards name addresses, and the sink's map holds the stub's address.

## Tasks
- [x] 1. Keep every network a service had: `stack-egress.test.ts`, a service with no declared networks beside one with `ipv4_address` on a custom subnet keeps `default` for both.
- [x] 2. The sink answers stub hosts from a map the run writes: `egress-sink.test.ts`, answered from the map where the service name resolves nowhere.
- [x] 3. The boot reads addresses from the daemon, hands them to the sink and the relay, and falls back uncontained with the reason: `boot-egress.test.ts`.
- [x] 4. `examples/pinned-app` boots contained, healthy, seeded and passing in CI: `scripts/pinned-boot.sh`.
- [x] 5. Self-checks for the QARE run: `.qa/checks/pinned-stack.mjs`, and `stack-egress.mjs` with a daemon stand-in.
