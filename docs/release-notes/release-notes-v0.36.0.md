# Wildhaven v0.36.0 Release Notes

**Release:** v0.36.0
**Date:** 2026-08-11
**Previous release:** v0.35.1

The biggest sync this fork has taken. Upstream v0.36.0 is a feature release, not
a patch: 1,760 commits over 3,473 files, carrying a new collection system, seven
class overhauls, an art overhaul across most of the shipping icon and model set,
and a large refactor pass through render, net, ui, sim, and server.

The merge behaved. 152 conflicts, and every one of them fell into a shape
`docs/upstream-sync.md` already names: a version surface carrying our branding,
an asset seal, a generated artifact, or a place upstream extended a wallet
feature this fork does not have. Nothing had to be reconstructed by hand.

## Highlights

- **The Reliquary**: a permanent trophy cabinet for unique spoils, with clear
  counts, per-page illumination, and a five-rung cosmetic Curator rank. 35
  pages, its own HUD tracker, window, and wiki section.
- **Seven class overhauls land together** (paladin, priest, shaman, hunter,
  rogue, druid, warlock), each with new talent engines under `src/sim/combat/`
  and their own render VFX.
- **The v0.36 art overhaul**: repainted item icons, 21 specialization emblems,
  creature-family and status crests, thirty new Book of Deeds crests, and
  eighteen corrected mob portraits.
- **Rifts, battlegrounds, and mounts** gain their sound layers; warrior shouts,
  stealth, and the rift mechanics all have authored cues now.
- A vendored `three` patch fixes a `compileAsync` disposal race that could
  throw during asset churn.
- **No dependency was added.** The ten wallet packages upstream still ships stay
  absent, `tweetnacl` and `@reown/appkit` were declined at the merge, and
  `tests/no_web3_regression.test.ts` passes.

## What came from upstream

### The Reliquary

`src/sim/reliquary.ts` plus `src/sim/content/reliquary.ts` define the catalog:
shelves (Conquerors, Professions, Horizons), pages, and relics keyed to item,
mark, mount, skin, or title ids. Completion is character-durable and cosmetic
only. The Curator rank has five rungs at 1 / 10 / 25 / 50 / 100 owned, and the
thresholds are deliberately not rescaled as the catalog grows.

The server observes and never invents: `refreshCuratorStanding` walks live sim
meta once per player, stamps rank plus the owned/total pair on the entity, and
the identity wire ships them as the sparse `crk`/`cro`/`crt` triple. No client
command can write a standing. The rarity read (`server/reliquary.ts` +
`reliquary_rarity_db.ts`) shares the deeds rarity TTL cache and its single
flight, so the characters walk never gains a second cadence.

### Class overhauls

Paladin, Priest, Shaman, Hunter, Rogue, Druid, and Warlock each get a talent
engine cluster under `src/sim/combat/` (for example `paladin_aegis.ts`,
`priest/vespers.ts`, `shaman_thundercall.ts`, `hunter_packlord.ts`,
`rogue_engines.ts`, `necromancy.ts`, `affliction.ts`, `destruction.ts`) with the
matching render work under `src/render/`. Warlock pets gain growth and skill
progression; druid forms gain a visual-selection core.

### Interface and content

- New guide pages: Interface, Commands, Mounts, Rifts, Reliquary, Editor.
- Arena results can now be draws, and the character sheet reports them.
- A per-device "Show Time Played" preference, with the character sheet's own
  privacy eye routed through the same write path as the Options row.
- The authored modular appearance (a look set at join and immutable for the
  session) rides the entity wire and survives character creation.
- A Wiki launcher on the side rail, the mobile bar, and the Esc menu, behind a
  confirm dialog so an accidental tap cannot yank a player out of a fight.
- A performance-doctor panel that produces a copyable diagnosis report.

### Performance and infrastructure

- Loading time, sky prewarm, and long-sim lane work; a hitch-forensics store and
  a frame-consistency referee under `docs/perf/hitch/`.
- Cached reads for the admin activity feed, guild roster, moderation queue, and
  lifetime-XP character rank; retention indexes for chat violations and player
  reports.
- The gate and CI pipeline gained a stall-rerun workflow and a large batch of
  step-level speedups.
- `tests/monolith_budget.test.ts` now ratchets a line-count ceiling per
  coordinator file, and `tests/duplicate_test_blocks.test.ts` refuses a
  byte-identical sibling test block (a defect that arrives through merges).

### Security

The vendored `patches/three@0.165.0.patch` guards `WebGLRenderer`'s
`compileAsync` poll against a program released mid-wait, which threw a
TypeError during asset churn. `three` is pinned exactly so the patch applies.

## What Wildhaven did on top

- **The web3 surface upstream grew was declined, again.** This release extends
  the wallet feature in seven new places, and each was resolved rather than
  merged: the `$WOC` holder badge on the inspect card and the player card, the
  two Show Wallet options rows (and their guide entry), the `/woctier` dev
  command, the holder-tier refresh half of the server flair cycle, the
  `ht`/`hb` identity wire fields, and `tweetnacl` + `@reown/appkit` in
  `package.json`. The Curator standing that upstream built INSIDE that same
  refresher was kept: it is a collection system, not a chain read, so
  `refreshAllFlair` now runs the curator sweep first and unguarded exactly as
  upstream intended, with the overlap guard left to the two awaited refreshers
  this fork still has (Discord, GitHub).
- **Two more `walletForAccount` mock keys were caught by the guard**, in
  `tests/inventory_sort_online.test.ts` and `tests/reliquary_wire.test.ts`. Same
  shape as the three v0.35.1 saw: an unused key on a `vi.mock('../server/db')`
  factory, inert at runtime, describing a module surface this fork does not
  export. The guard named them by file and line, which is what it exists for.
- **`server/discord.ts` keeps `discordEnabled()`.** Upstream deleted the export
  in v0.36.0 once its own last caller went away; this fork still has one, the
  Discord sign-in advert on the auth screen, so the function is restored with a
  note saying why it outlives upstream's copy.
- **Every source seal re-minted from this fork's lockfile.** All 27 GLBs, the
  polish provenance mint, the media manifest, and the test and metadata literals
  were re-minted and re-pinned; `pnpm-lock.yaml` is a declared fingerprint input
  and this fork's dependency set is not upstream's. The frozen polish capture
  identity (`ACCEPTED_POLISH_V2_TOWN_SOURCE_FINGERPRINT`) is deliberately
  untouched: it moves only when the captures themselves are retaken.
- **Branding held through the silent half too.** The conflicts were the easy
  part; upstream also ADDED project-named strings on lines no conflict touched.
  The wiki launcher's canonical URL, the performance doctor's panel and report
  titles, the item and skill art provenance records for four classes, and the
  preserved marketing rows in `public/sitemap.xml` all arrived as
  worldofclaudecraft and were rebranded. `npm run release:check -- --version
  0.36.0` is green across every surface it owns.
- **The player card's footer band is stated directly.** Upstream derives it from
  the holder badge it draws there. This fork draws no badge, so
  `card_layout.ts` now names `FOOTER_BAND_TOP` at the same y, which keeps the
  card geometry byte-identical to the layout upstream tuned.
- **Four guards upstream's own changes made untrue again.** None of them was in
  a file the resolution touched, which is why only the full suite found them.
  Upstream's new `compression` windup style resolves its VFX anchor without a
  scratch on a path `update()` reaches, so `tests/ability_vfx_frame_cost.test.ts`
  caught a real per-frame allocation and it is fixed at the source rather than
  declared a one-shot it is not (that guard also named `drawStunStars`, which
  upstream renamed to `drawCcBand`). Upstream's new `tests/ci_changed_base.test.ts`
  fakes a `rev-parse --verify <ref>^{commit}` probe, but this fork's
  `resolveSelectBase` deliberately uses `rev-list`, because the gate spawns
  through cmd.exe on win32 where `^` is the escape character. And
  `src/main.ts` is about 1,400 lines shorter here than upstream, so the
  monolith ratchet's ceiling was handing it that much free growth.
- **The portrait manifest needed a new kind of write, not a rerender.** The
  browser render bundle's import graph reaches the world and content modules, so
  this fork's bundle digest can never equal upstream's and
  `docs/achievements/placeholder-art-completion-2026-08-09/mob-portrait-source-manifest.json`
  is permanently stale against it. Re-accepting demanded a receipt from a
  230-portrait rerender, and a rerender only reproduces the committed bytes on
  the platform that produced them: running it here rewrote every portrait, which
  is reshipping art nobody meant to change. `assertManifestWriteAuthorized` now
  lets through exactly the drift its own diff explainer already classifies as
  bookkeeping (no portrait row, no tracked render input and no shipped byte
  moved, only the bundle digest), with a test for the branch and for both ways of
  abusing it. The re-accepted manifest moves three lines.
- All 21 locales are complete with no pending rows (12,411 keys).

## What did not come across

- **The `$WOC` utility surface**, in every form this release extended it: the
  holder badge, the wallet options, the wallet-handoff page, and the Seeker
  entitlement. The upstream browser suite that covers the Seeker rewards layout
  is deleted rather than skipped.
- **`docs/prd/woc/`**, upstream's $WOC/web3 spec set, along with the doc rows
  that pointed at it.

## Known gaps

Carried forward, still open:

- The legal documents carry `[OPERATOR: ...]` placeholders and must be filled in
  before the site is published.
- Community and social links point at `wildhaven.example`, and so does the
  updater's host and the wiki launcher's canonical URL. A build baked with any
  other origin lands on the `dev` update channel by design.
- The in-game News panel reads GitHub releases; against a private repository that
  read needs a `GITHUB_TOKEN` on the server, or the panel stays empty.
- The full test suite needs about four workers on a developer machine
  (`npx vitest run --maxWorkers=4`, or `GATE_MAX_WORKERS=4` for the gate). The
  suites that bind a real port time out under more parallelism; they pass in
  isolation.
- `core.autocrlf=false` is not recorded in `.gitattributes`, so a fresh Windows
  clone inherits a line-ending trap that shows up as roughly fifty failures in
  the golden-master suites.

New with this release:

- **The parse ingest transport rule got looser upstream, and the sync carries
  that.** `server/parse/flags.ts` used to reject a cleartext ingest URL unless
  it was loopback; v0.36.0 widened the exemption to any RFC1918 address, so the
  parse shared secret can now ride plain HTTP across a private network segment.
  It is off by default (the whole recorder is env-gated) and no secret is
  logged, but any host on that segment can read the bearer. Whoever turns the
  recorder on should terminate TLS at the parse service rather than lean on the
  private-address exemption. Left as upstream shipped it so the sync's diff
  stays a merge; changing it is its own change.
- **`GET /api/referrals` carries no rate-limit policy.** It declares
  `[activeGuard]` and then does two database reads per call. Inherited verbatim
  from upstream, but it now lives in a fork-owned module
  (`server/card_routes.ts`, this fork's rename of upstream's `wallet.ts`), so it
  is this fork's to fix.
- **The SFX export suite's skip is wider than its reason.** v0.35.1 wrapped the
  whole byte-determinism case in `it.skipIf(!canRunPosixShell())` because part
  of it runs the artifact's POSIX `install.sh`. On a host without `sh` that also
  drops the bundle determinism, runtime-pack, per-blob checksum, and
  draft-leak assertions, none of which need a shell. CI is Linux, so the
  coverage is intact where it counts; splitting the case is the fix.
- **Two guide FAQ answers still describe a token this fork does not have.**
  `guide.home.faq.a2` and `guide.faqPage.a2` answer "do I need a crypto wallet"
  with "no, the optional community token only adds cosmetic flair and a share of
  the daily rewards prize pool". The first half is true here and the second is
  not: there is no token. Both predate this sync (they are on `main` already),
  so rewording them is left to its own change rather than widened into a merge
  diff, but they are the last player-visible copy in the tree that implies a
  token exists.
- **The `walletForAccount` mock residue is a standing tax, not a one-off.** The
  v0.35.1 notes recorded it as a gap and PR #8 closed it by stripping all 77
  sites and pinning the whole db-layer wallet accessor family in the guard. This
  sync brought two back, and the guard caught both. Expect one or two per sync
  for as long as upstream ships that module: the fix is the guard, not a
  one-time cleanup.
