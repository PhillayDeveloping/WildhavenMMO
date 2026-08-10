# Syncing a new upstream release

Wildhaven is a real GitHub fork of
[levy-street/world-of-claudecraft](https://github.com/levy-street/world-of-claudecraft)
(MIT). Upstream keeps shipping releases; we keep a rebranded, web3-free tree on
top. This is how the two meet.

## Why the fork replaced the old snapshot

The predecessor repo (`PhillayDeveloping/wildhaven`) was imported as a *pristine
snapshot* of upstream v0.34.0 with its own root commit. It shared no git history
with upstream at all, so there was no merge base and every sync had to be done by
hand: the v0.35.0 attempt there touched 1,740 files as a single squashed commit.

This repo is a genuine fork, so `git merge` has a real three-way base. The same
v0.35.0 integration produced 90 conflicts instead, and git resolved the rest.
Keep it that way: never re-import a snapshot, always merge.

## The routine

Upstream tags each release (`v0.35.0`, `v0.36.0`, ...). One sync, one branch.

```bash
git fetch upstream --tags
git checkout -b sync/upstream-v0.36.0 main
git merge v0.36.0
```

Resolve, verify, then land it:

```bash
git checkout main
git merge --no-ff sync/upstream-v0.36.0
git push origin main
```

`main` carries our code and is the default branch. Upstream is a remote, not a
branch here, so there is no mirror branch to keep in step.

> **Never press GitHub's "Sync fork" button.** It fast-forwards the default
> branch to upstream, which would discard the Wildhaven tree wholesale. Sync only
> through the merge above.

If `upstream` is not configured in a fresh clone:

```bash
git remote add upstream https://github.com/levy-street/world-of-claudecraft.git
```

## Resolving: what wins, and why

Conflicts fall into a few repeating shapes. The rules below are what the v0.35.0
sync actually used.

| Shape | Resolution |
|---|---|
| Branding (`world-of-claudecraft`, `World of ClaudeCraft`, `com.worldofclaudecraft`, `updates.worldofclaudecraft.com`) | Take upstream's **content**, keep our **names**. Version numbers follow upstream. |
| A file we deleted, upstream edited (web3) | Stays deleted (`git rm`). |
| A file upstream deleted, we only rebranded | Accept the deletion. |
| Binary assets + their metadata JSON | Take upstream's, then re-mint (below). |
| Asset fingerprint pins in tests | Take upstream's, then re-mint and re-pin. |
| Generated artifacts (`*.generated.ts`, `pnpm-lock.yaml`, `sitemap.xml`) | Do not hand-merge. Take one side, then regenerate. |
| i18n locale overlays | Keep **both** sides: each only ever adds keys. Drop upstream keys for UI we do not ship. |
| Numeric pins (route counts, registry sizes) | Do not guess. Count the real surface, or let the suite tell you. |

Two things that are easy to get wrong:

- **`package.json` is not a branding-only conflict.** Taking upstream's file to
  pick up a version bump also takes their dependency list, which re-adds the
  wallet stack. Merge the version and keep our dependency set.
- **CREDITS.md** carries one sentence about art licensed to Levy Street under a
  permission that did not transfer. It is not ours to rebrand; leave it.

After touching a fingerprinted asset input (including a lockfile move):

```bash
node scripts/assets/remint_lockfile_fingerprints.mjs
node scripts/build_media_manifest.mjs generate
```

## The part git will not tell you

**A conflict is not the boundary of the problem.** Git only raises a conflict
when both sides touched the same lines. Code upstream *adds* on lines we never
touched merges silently, and upstream's lines are full of web3.

The v0.35.0 sync auto-merged, with no conflict marker:

- the payout runner's `prize_usd` / `tx_signature` / `signed_transaction`
  columns into our `prize_copper` schema,
- ten wallet dependencies, via `package.json`,
- a whole new upstream test suite built on `prize_usd` fixtures.

`tests/no_web3_regression.test.ts` exists to catch exactly this. It fails the
build when a chain dependency, a wallet import, a removed module, or a
payout-runner identifier comes back, and it holds a counted pin on the payout
columns and tables still spelled in the TypeScript sources it scans (its
`SOURCE_DIRS`, minus the fixture files it lists) so they cannot grow. It
reports; it never edits. Run it early in a sync:

```bash
npx vitest run tests/no_web3_regression.test.ts
```

If it fails, read what it names and decide. If upstream added a genuinely new
web3 surface, extend the lists there in the same change.

Those columns are no longer named by any SQL this fork executes. `voidPayout`
and `restorePayout` selected `prize_usd`/`tx_signature` and cleared
`tx_signature`/`signed_transaction`/`error` until that was fixed, which crashed
both of them on any database created by the current `server/db.ts`. Note the
provenance, because it is easy to read this as the bullet above being cleaned
up: those broken SELECTs were already in the tree at `679546e96^1`, inherited
from the old snapshot repo, so the sync widened an existing defect rather than
introducing one. `tests/daily_rewards_payout_moderation_schema.test.ts` now runs
those two functions against a column set built by applying `ensureSchema`'s own
DDL, so a statement that names a column boot does not create fails in that suite
rather than in production. Reach for that suite's shape for any other `*_db.ts`
a sync touches: a fake that answers by statement substring cannot see this class
of defect.

## Verifying before you land

```bash
pnpm install          # after any package.json change, so the lockfile follows
npm run check:ts
npm test
```

`npm run gate` is the full merge bar and mirrors CI; prefer it before pushing a
sync. Note that `pretest` regenerates the i18n tables and wiki content, so run
the suite through `npm test` rather than a bare `vitest run` when generated
artifacts are in play.

## What this fork deliberately keeps

Not everything that looks web3 is. **Claudium** stayed: the store, its window,
and its icons are an ordinary in-game currency here, disconnected from any chain.
Do not "clean it up" on sight, and do not let the guard's name mislead you about
it.
