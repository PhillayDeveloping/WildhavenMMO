# Wildhaven v0.35.0 Release Notes

**Release:** v0.35.0
**Date:** 2026-08-08
**Previous release:** v0.1.0

The release where Wildhaven stops being a snapshot and becomes a fork. It carries
everything upstream shipped in v0.35.0, which is their PvP release, on top of the
rebranding and web3 removal that v0.1.0 introduced, and it adds the machinery that
keeps those two things from fighting each other next time.

A note on the number, since it jumps from 0.1.0. Wildhaven v0.1.0 was cut from a
copy of world-of-claudecraft v0.34.0 that shared no git history with it, so every
upstream release had to be re-integrated by hand, file by file. This release moves
the project onto a real fork whose history connects to upstream's, and adopts
upstream's version number so the two can be compared directly. A future upstream
release now arrives as an ordinary merge on a `sync/upstream-vX.Y.Z` branch
(`docs/upstream-sync.md`), not a reconstruction.

## Highlights

- Everything in upstream v0.35.0: the Thornhollow Fields battleground, the WARFARE
  honor tier, a modular character creator, swimming, cast-paced professions, and
  bespoke ability cast animations for every class.
- Wildhaven's web3 removal is now enforced by a test rather than by memory.
- The desktop app is Wildhaven again. The merge had quietly handed its identity
  back to upstream, including the deep link Discord sign-in uses.
- The test suite runs green on Windows, and the three build tools that were broken
  there are fixed.
- Wildhaven's own copy is localized too, so all 21 locales are complete: not just
  upstream's content but the Daily Rewards panel and the Ravenpost prize letter
  this fork wrote when it replaced the crypto payout with in-game coin.

## What came from upstream

Upstream's own notes for v0.35.0 are the full list; the headline items are:

- **Thornhollow Fields**, a ranked 5v5 capture-the-flag battleground with flags,
  keeps, a queue, a live scoreboard, and a kill feed.
- **The WARFARE honor tier**: five item-level-31 PvP sets behind an honor vendor,
  a lifetime-honor rank ladder, and battleground deeds.
- **A modular character creator** with a tabbed appearance UI and the Fit Studio,
  so hair, beards, makeup, outfits, and jewellery materials compose instead of
  shipping as fixed presets.
- **Swimming as a real system**: strokes, camera diving, a breath meter, and open
  sea.
- **Cast-paced professions** with a player commission order board, tool recharge,
  and gather nodes on the zone map.
- **Pets that scale from their owner**, with their own health frame, party-frame
  slivers, and combat events delivered to you.
- **A pose-sample-and-blend animation pipeline**, with bespoke ability cast
  animations for six classes and new attack clips for a long list of mobs.
- Twenty-one locales complete, plus a large batch of interface, accessibility,
  admin, and performance work.

Everything above arrived through the merge and is upstream's work, not Wildhaven's.

## What the merge nearly took away

A fork inherits its upstream's diffs, and git resolves most of them without
asking. A file this project deleted and upstream merely edited raises a conflict;
code upstream adds on lines this project never touched merges in silently. Three
things came back that way, none of them with a conflict marker:

- **Ten web3 dependencies**, reintroduced by taking upstream's `package.json`
  wholesale to pick up a version bump. All were unreferenced, so nothing failed.
- **The external payout runner's columns** (`prize_usd`, `tx_signature`,
  `signed_transaction`), merged into this fork's `prize_copper` schema.
- **The desktop app's identity.** The `build` block came back as upstream's:
  application id `com.worldofclaudecraft.desktop`, product name "World of
  ClaudeCraft", and the URL scheme `worldofclaudecraft://`. The client still sends
  `wildhaven://desktop-login`, so a packaged build would have registered one scheme
  and been handed another: Discord sign-in on the desktop app would have failed at
  the handoff, on a build whose installer also carried the wrong name.

`tests/no_web3_regression.test.ts` now fails the build on all three shapes. It
reports and refuses; it never edits. An automatic stripper would rewrite code
nobody reviewed, and guessing wrong there is a silent production defect rather than
a loud test failure. The guard sweeps every position in `package.json` that names a
package, not just the dependency maps, because one survivor of the original cleanup
(`@reown/appkit`) was sitting in pnpm's build-script allowlist where nothing looked.

## Windows

- The test suite runs green on Windows. Most of what was red was not a defect
  (line endings from a `core.autocrlf=true` clone, and parallelism contention), but
  underneath it were ten guards that reported a pass they had not earned and three
  build tools that genuinely did not work.
- **The SFX Studio was unusable on Windows.** Its path-containment check compared
  against a hardcoded `/`, so every check rejected paths that were correctly inside
  their root.
- The asset-pipeline inventory crashed on repo-relative paths, and the two icon
  converters failed at cleanup after a conversion that had already succeeded.
- `node scripts/gate_select.mjs`, the pre-merge gate, could not run at all on
  Windows: it probed its diff base with git's `^{commit}` syntax through a
  `shell: true` spawn, and cmd.exe treats `^` as its escape character, so the
  probe reached git with the caret eaten and every base failed to resolve.
- Suites are gated on a probed capability rather than on `process.platform`, so a
  Windows machine with Developer Mode enabled, or with Git for Windows on PATH,
  runs them. The coverage returns when the capability does.

## Desktop

- A Windows installer ships with this release, built locally and attached to the
  GitHub release by hand. The desktop publish workflow's tag trigger stays off:
  it needs an update host and two signing identities this project does not have
  yet, so a tag push could only fail.
- **The installer is not code-signed.** Windows SmartScreen will warn on it
  ("Windows protected your PC"); More info, then Run anyway. Signing needs an
  Azure Trusted Signing or Key Vault certificate, and reputation accrues only
  after a signed build has been installed many times.
- **The realm address is baked in at build time**, and a packaged build
  deliberately ignores runtime configuration, so the app cannot be pointed at
  another server after the fact. A realm that moves needs a new installer.
- There is no auto-update feed behind this build. The updater's host
  (`updates.wildhaven.example`) is a placeholder, and a build baked with anything
  other than that origin lands on the `dev` update channel by design, so an
  installed build stays on this version until a newer installer is run.

## Known gaps

Carried forward from v0.1.0, still open:

- The legal documents carry `[OPERATOR: ...]` placeholders and must be filled in
  before the site is published.
- Community and social links point at `wildhaven.example`.
- The in-game News panel reads GitHub releases; against a private repository that
  read needs a `GITHUB_TOKEN` on the server, or the panel stays empty.

New with this release:

- `voidPayout` and `restorePayout` still read payout-runner columns this fork's
  schema does not create, so they work only against a database migrated from an
  older build. The web3 guard pins the count so an upstream sync cannot grow it
  while the cleanup is pending.
- The full test suite needs about four workers on a developer machine
  (`npx vitest run --maxWorkers=4`, or `GATE_MAX_WORKERS=4` for the gate). The
  gate sizes its pool from the core count, and the suites that bind a real port
  time out waiting for it under that much parallelism; they pass in isolation.
- `core.autocrlf=false` is not recorded in `.gitattributes`, so a fresh Windows
  clone inherits a line-ending trap that shows up as roughly fifty failures in
  the golden-master suites.
