# Wildhaven v0.35.1 Release Notes

**Release:** v0.35.1
**Date:** 2026-08-10
**Previous release:** v0.35.0

The first upstream sync that behaved the way v0.35.0 promised it would. Upstream
v0.35.1 is a patch release: performance work, a dependency advisory pin, and the
version surfaces. No new gameplay content, no new systems, no balance changes.

The sync itself is the quiet headline. v0.35.0 moved this project onto a real
fork of world-of-claudecraft, and the payoff arrives now. Because the merge base
is genuinely upstream v0.35.0, git had only the v0.35.0 to v0.35.1 delta to
reason about: 20 commits over 182 files, and 64 conflicts, every one of them
either a version surface carrying our branding or an asset seal. Nothing had to
be reconstructed by hand, and no conflict touched behavior.

## Highlights

- Ravenpost mail no longer scans the realm's whole mail book on every read. It is
  indexed by recipient, which upstream measured at roughly a fifth of total
  server CPU on a large book.
- Two snapshot fields that were rebuilt and re-serialized 20 times a second for
  every player, the mail projection and the commission order board, now ship on a
  4 Hz cadence behind a change gate. The unread envelope count stays ungated on
  purpose: it is an O(1) read and the badge should never lag.
- Ability VFX stopped allocating on the order of a hundred throwaway vectors per
  frame to read three floats, and ground decals thin their drape with distance.
- Weapon-skin VFX worn by other players fade with distance and under the frame
  budget. This is the one change in the release that is meant to be seen. Two
  others are visible in principle and argued sub-perceptual: thinned ground-mark
  drape accepts a small vertical error at distance, and another player's mailbox
  or board action can now take up to 250 ms to reach you instead of 50 ms.
- `nanoid` is pinned past GHSA-2v37-7h3g-55p8.
- Every asset source seal is re-minted from this fork's own lockfile, not
  upstream's.

## What came from upstream

### Server and sim performance

- **The Ravenpost mail index.** `src/sim/mail/mail_index.ts` keeps letters
  bucketed by recipient, with an unread count and an undelivered set beside them.
  The three hot reads that used to filter the realm-global book per player per
  call now walk two buckets. Delivery still lands letters on the exact tick the
  old scan would have.
- **The mail wire gate.** The mail projection, letter bodies included, used to be
  rebuilt and re-serialized every tick for anyone standing at a raven pillar. It
  is now gated on a mail revision at a 4 Hz cadence with a two second staleness
  backstop, and the viewer's own mail commands re-arm the gate so their action
  lands on the next snapshot. The revision bump on a take is conditional, so a
  repeated take on an already-emptied letter cannot force a rebuild for every
  nearby viewer.
- **The commission order board gate.** Same recipe. The board read is O(board)
  per player per tick and the board grows with realm activity, so it is now gated
  on a board revision that every mutation site advances, through a new
  `SimContext` callback rather than direct writes.
- **A per-key-group breakdown of the self snapshot.** The server's one opaque
  `bcastSelf` total is decomposed into sixteen named buckets, built only while
  the perf-detail switch is on, and surfaced in the admin dashboard's Tick Perf
  page. Both incidents above had hidden inside that total for a full diagnosis
  round each.

A residual upstream names rather than fixes: the mail and board revisions are
realm-global, so a busy realm degrades the change gate to the plain cadence win.

### Render performance

- **Allocation-free VFX anchors** (`src/render/vfx_anchor.ts`). Per-frame paths
  resolve into caller-owned scratch; one-shot spawns keep the retainable vector.
- **Ground-drape distance LOD** (`src/render/drape_lod_core.ts`). Small discs
  sample fewer rim vertices with distance, bounded by a world-space spacing cap
  and an eight-sample floor. Only vertical fidelity changes: every sampled vertex
  keeps its exact world position, so footprints and radii are unchanged. Wide
  shock rings keep the exact drape by construction.
- **Ground auras stop re-draping while standing still.** Their cosmetic breath
  was crossing an absolute threshold several times a second; the threshold is now
  relative, and real movement still re-drapes.
- **Prefix uploads** for ribbons and overlay sprites, instead of re-uploading
  worst-case capacity every live frame.
- **Weapon-skin VFX shed** (`src/render/weapon_vfx_shed_core.ts`). A VFX-bearing
  weapon skin on another player fades on two multiplied arms: viewer distance,
  and the frame-budget governor. It is a fade, not a cull: the floor stays clear
  of the point at which drawing stops, the rig's point light stays visible and
  only dims, and the wearer, nameplate, cast bar, auras, and the weapon model
  itself are untouched. The distance arm is anchored to a fixed range rather than
  the crowd-adaptive band, so two players standing in the same spot see the same
  thing. `docs/design/graphics-settings-fairness.md` records it on the cosmetic
  list with both arms spelled out.

### Security

`nanoid` is pinned past GHSA-2v37-7h3g-55p8 through a `pnpm.overrides` entry.
This fork's lockfile already resolved a fixed version, so the merge recorded the
declaration without moving a resolution.

### Interface

One new admin string, the self-snapshot heading on the Tick Perf page, filled
across every locale. All 21 locales remain complete with no pending rows.

## What Wildhaven did on top

- **Every source seal re-minted from this fork's lockfile.** Asset source
  fingerprints hash a pinned input list that ends in `pnpm-lock.yaml`, and this
  fork's dependency set is not upstream's, so upstream's seals could not simply
  be merged. All 27 GLBs, the polish provenance mint, the media manifest, and the
  test and metadata literals were re-minted and re-pinned. The frozen polish
  capture identity is deliberately untouched: it moves only when the captures
  themselves are retaken.
- **Branding held through every conflict.** The version numbers follow upstream
  to 0.35.1; the names, hosts, bundle identifiers, and installer filenames stay
  Wildhaven's. `npm run release:check -- --version 0.35.1` is green across every
  surface it owns, including all 20 localized README badges.
- **No dependency moved.** The merge added zero packages. The ten wallet packages
  upstream still ships remain absent, and `tests/no_web3_regression.test.ts`
  passes.
- The README's upstream watermark now reads v0.35.1.

## What did not come across

- **The OTA native build-number fix.** Upstream landed it and then reverted the
  whole merge commit, documentation included, before tagging v0.35.1. Nothing of
  it survives in the release, so nothing of it is here either. The underlying
  problem, that a store-fresh device reporting a native build number is not
  offered an update, is still open upstream. It costs this fork nothing today
  because there is no auto-update feed behind these builds, but it will matter
  the first time there is one.

## Known gaps

Carried forward, still open:

- The legal documents carry `[OPERATOR: ...]` placeholders and must be filled in
  before the site is published.
- Community and social links point at `wildhaven.example`, and so does the
  updater's host. A build baked with any other origin lands on the `dev` update
  channel by design.
- The in-game News panel reads GitHub releases; against a private repository that
  read needs a `GITHUB_TOKEN` on the server, or the panel stays empty.
- The full test suite needs about four workers on a developer machine
  (`npx vitest run --maxWorkers=4`, or `GATE_MAX_WORKERS=4` for the gate). The
  suites that bind a real port time out under more parallelism; they pass in
  isolation.
- ~~Two cases do NOT pass in isolation and are slow rather than contended:
  `tests/charge_parallel_recharge.test.ts` ("each spent charge returns its own
  cooldown after ITS spend") and `tests/dungeon_finder.test.ts` ("a decline
  returns accepted units to the queue"). Both exceed the 20 second case timeout
  on a Windows developer machine with nothing else running, and both pass at
  `--testTimeout=180000`.~~ **Closed after this release.** The 28 ms per tick did
  point at `Sim` rather than at the tests, as suspected. Neither suite exercises
  ambient world content, but a default `Sim` spawns the whole 11-zone world and
  ticks every camp mob's idle AI, so a case that ticks a 60 second cooldown out
  spent most of its time in idle-mob wander terrain sampling. Both now build the
  standard subsystem-sized world fixture, which trims spawns without touching
  terrain. The live server never paid this: its `Sim` opts into
  `idleMobTickRadius`. Note for the record that this was never a sync
  regression, and CI never saw it: a pre-merge checkout reproduced both
  identically, and all eight release-gate test shards were green on Linux
  throughout.
- `core.autocrlf=false` is not recorded in `.gitattributes`, so a fresh Windows
  clone inherits a line-ending trap that shows up as roughly fifty failures in
  the golden-master suites.

New with this release:

- 77 test files mock a `walletForAccount` database function this fork's server
  does not export. 74 of them were inherited from the v0.35.0 snapshot import,
  and three arrived in this sync: `tests/commission_wire_cadence.test.ts`,
  `tests/mail_wire_cadence.test.ts`, and `tests/self_wire_phase_breakdown.test.ts`
  are new upstream suites that carry the key in their `server/db` mock factory.
  It is inert, since an unused key on a mock factory is ignored, but this is the
  exact shape `docs/upstream-sync.md` warns about: the surface grew on lines no
  conflict touched, and it passed because `tests/no_web3_regression.test.ts`
  scans those files without naming that identifier. Adding the name to the guard
  and stripping all 77 is left to its own change, so this sync's diff stays
  scoped to the merge.
- The tag-namespace guidance in `docs/upstream-sync.md` is still on an unmerged
  branch. Upstream and Wildhaven tag the same version numbers, so a plain
  `git fetch upstream --tags` writes upstream's commit into our own release tag
  name. This sync hit exactly that and had to delete the stray tag by hand.
