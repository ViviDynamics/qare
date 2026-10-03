# Runner capabilities and placement

Issue #76

## The gap

A run finds out where it cannot execute by failing there. Three places already
refuse or block by name for something the host lacks, each in its own words
and at its own moment: the Electron driver for a host with no display (#72),
provisioning for the same (#75), and the client boot for a host that cannot
make an egress cell (#223). None of them is declared, none is in the evidence
as a requirement, and a build that needs macOS has no way to say so: it is
installed on a Linux host and fails at launch. The evidence says whether a run
was in a container, and nothing about the machine underneath.

## Scope

In:

- **One declared concept, `requires`, in the profile.** A top-level section
  any profile may carry (`app`, `target` or `client`):

  ```yaml
  requires:
    os: macos              # linux, macos or windows
    virtualisation: true   # hardware virtualisation, for an emulator
    devices: [android]     # attached devices, by kind
  ```

  Unknown keys, an unknown operating system or device kind, and a section that
  contradicts the rest of the profile (a contained client build is launched in
  a Linux cell, so it cannot require macOS or Windows) are refused when the
  profile loads.
- **What a profile already implies is the same concept.** `requirementsOf`
  (`placement.ts`) returns what the profile declares plus what its shape
  derives: a contained client build requires a `cell`; an uncontained one
  requires a `display`. The requirement table is in one place, and a device
  driver (#73, #74) adds its row there.
- **Host facts, detected once.** `detectHost` reports the host kind: operating
  system, architecture, whether hardware virtualisation is usable, and what
  kind of runner the run is on (GitHub-hosted, self-hosted, or none).
  Attached devices, the cell and the display are probed only when a profile
  requires them, through the probes that already exist (`clientCellProblem`,
  `electronDisplayProblem`) and one new one (`adb devices`).
- **A run refuses before any provisioning.** `runJob` checks the requirements
  against the host before either side starts: before a base checkout, a build
  command, an install or a compose boot. Unmet means verdict `refused` (the
  repository's code was not faulted, so the check run is neutral), every
  criterion `unverified`, and a reason that names each thing that is missing.
  The cell and display refusals move here from the boot, so they are one
  path with the declared ones. The boot keeps its own guards for callers of
  `bootApp` that do not go through a run.
- **Evidence.** `result.json` gains `environment.host` (`os`, `arch`,
  `virtualisation`, and `runner` when the run is on one) on every result,
  each side's included, and `requirements` when the profile has any. The
  comment names the host kind and what the profile requires.
- **Public repositories stay on hosted runners.** A run that finds itself on a
  self-hosted runner for a public repository refuses, by name, unless the
  caller opted in. The pipeline hands execute the three facts (the runner's
  kind, the repository's visibility, the opt-in) and gains one input,
  `self-hosted`, empty by default; `allow` is the opt-in. Decided in
  `placementProblem`, in code, and tested.
- `qare doctor` reports the host kind and holds a profile's declared
  requirements to it, through the same functions.
- Docs: SPEC "Clients" (a Requirements section) and "Pipeline", the pipeline
  guide ("Your own runners", the inputs table), `docs/schemas.md`.

Out:

- Provisioning runners (the issue's own exclusion).
- A device driver, an emulator, device claiming and reset (#73, #74, #77).
  This issue only detects that an Android device is attached; nothing drives
  one.
- macOS and Windows host profiles (#90). Detection of those hosts is tested
  with fakes; nothing here prepares one.
- Handing `/dev/kvm` to the pipeline's run container. No driver uses it yet
  (#73), so inside the pipeline `requires.virtualisation` is honestly unmet.
- The docker daemon a compose boot needs. A boot that cannot reach it stays
  `blocked` with compose's own output attached (#75): the daemon being there
  and the stack coming up are one failure path, and it already names itself.
- Containing command checks (#224) and evidence kinds (#78).

## Assumptions

- "Target" in the issue is what a profile points a run at, so requirements are
  declared per profile, not per criterion or per check.
- An unmet requirement is `refused`, not `blocked`: the issue's word, and the
  outcome whose check run is neutral. This changes the two existing refusals
  (no cell, no display) from `blocked` to `refused`, and they now come before
  the check that the build is there.
- An attached device is a physical one. `adb devices` entries named
  `emulator-*` are not counted: an emulator is what `virtualisation` is for,
  and starting one is #73 and #77.
- Only Android devices are a kind for now. `ios` is refused when the profile
  loads, naming #74, instead of being accepted and never detectable.
- Hardware virtualisation is detected on Linux only (`/dev/kvm`, readable and
  writable). On another host a run that requires it is refused, saying that
  qare cannot detect it there.
- The runner's kind is what GitHub Actions says (`RUNNER_ENVIRONMENT`), handed
  into the run's container as `QARE_RUNNER_ENVIRONMENT`. A repository's
  visibility is what the pipeline hands in (`QARE_REPOSITORY_VISIBILITY`).
  Only `public` on `self-hosted` is refused; a run that is told neither is a
  run somebody started by hand, and is left alone.
- In a run over several apps, an app whose requirements are unmet is refused
  for that app alone, the way a missing profile is (#107). The public
  repository rule refuses the whole run.
- No version bump: the result schema only gains optional fields.

## Tasks

- [ ] 1. `requires` in the profile: profile tests for the three keys, unknown
  keys and values, `ios` naming #74, and a contained client that requires
  macOS.
- [ ] 2. `placement.ts`: `requirementsOf`, `detectHost`, `unmetRequirements`
  and `placementProblem`, tested with fake hosts (macOS, Windows, a
  self-hosted runner, no `/dev/kvm`, adb output).
- [ ] 3. The run refuses before provisioning: a run requiring macOS on a Linux
  host is `refused` naming it, with no boot, no install, no base checkout; the
  cell and display refusals go the same way; a several-app run refuses the one
  app; a public repository on a self-hosted runner is refused unless allowed.
- [ ] 4. Evidence: `environment.host` and `requirements` are written, loaded
  back, and named in the comment; an older result still loads.
- [ ] 5. `qare doctor` reports the host and the declared requirements.
- [ ] 6. The real CLI: `qare run` on this host with a profile that requires
  macOS exits 3 with the named reason and writes nothing but the result.
- [ ] 7. The pipeline: the `self-hosted` input, and the three facts handed to
  execute; workflow tests.
- [ ] 8. Docs.
