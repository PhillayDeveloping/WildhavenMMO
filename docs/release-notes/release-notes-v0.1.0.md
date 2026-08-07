# Wildhaven v0.1.0 Release Notes

**Release:** v0.1.0
**Date:** 2026-08-07
**Previous release:** none, this is the first

The first Wildhaven release. It covers two pieces of work: separating the game from
its upstream origins, and getting a self-hosted realm to the point where other people
can actually log in and play it.

A note on the number. `package.json` still reads 0.34.0, which is the version this
codebase carried when it was forked. That history is not Wildhaven's, so releases
start at v0.1.0. The two numbers will disagree until the file is bumped, which is
deliberately deferred: `package.json` is an input to an asset source fingerprint, so
changing it re-stamps fourteen shipping models and their signed review records.

## Highlights

- Every trace of the previous cryptocurrency integration is gone, not disabled.
- Daily Rewards survives it, paying in-game coin instead of a crypto payout.
- The game is Wildhaven throughout, down to the name of the world you log in to.
- A realm can be hosted from a home machine against a hosted database, with the
  certificate configuration living in the repo rather than on one operator's PC.
- Sign-in offers only the methods the realm actually supports.
- Password recovery is reachable, and its configuration is now verifiable in advance.

## The world

- The default realm is **Wildmoon**. It was previously named after the upstream
  project, and that name reached players on the landing page, in the world list, in
  the Champion title, and in the restart notice in every language.
- Renaming a realm is not cosmetic: it is the scope key for saved characters,
  friends, guilds and world state. Both places an operator would be standing when
  they change it now say so.

## Economy

- Daily Rewards pays a purse of in-game copper, split down the ten ranks at the day
  rollover and delivered by Ravenpost letter at the winner's next sign-in. The claim
  and the paid mark happen in one statement, so a reconnect cannot collect twice.

## Sign-in and accounts

- "Continue with Discord" now appears only when the realm has Discord configured.
  It previously showed on every build, so a realm without an OAuth application
  offered a button whose only possible outcome was an error.
- Password recovery works through any provider with a JSON send API; Resend needs no
  configuration beyond three values. There is deliberately no SMTP transport.
- `node scripts/email_check.mjs <address>` sends one real message through whatever
  transport is configured and reports which one answered. Mail sends are
  fire-and-forget by design, and the default transport only logs, so a realm with no
  mail configured is indistinguishable from a working one until a player is locked
  out of their account.

## Hosting

- `DATABASE_CA_CERT` points at a root certificate for databases that chain to a
  private root, which Supabase's pooler does. Verification stays full: the root is
  named rather than looked up in the machine's trust store. This previously required
  a machine-level environment variable that could not live in `.env` and that a new
  machine or a second checkout lost silently.
- `docs/host-for-friends.md` covers running a realm from a home machine: one port
  carries the client, the API and the WebSocket, so there is a single thing to expose.
- The anti-bot origin guard has a documented failure worth knowing before it happens.
  In production it matches the browser's `Origin` against the request's own `Host`, so
  a tunnel or proxy that rewrites `Host` refuses every sign-in while the site itself
  loads perfectly. It reads exactly like a wrong password. `WEB_ORIGINS` is the fix.

## Desktop

- A Windows installer ships with this release. It is baked with a fixed server
  address at build time and a packaged build deliberately ignores runtime
  configuration, so a new installer is required if the realm's address changes.

## Known gaps

- The legal documents carry `[OPERATOR: ...]` placeholders. They must be filled in
  before the site is published.
- Community and social links point at `wildhaven.example`.
- The in-game News panel reads GitHub releases. Against a private repository that
  read needs a `GITHUB_TOKEN` on the server, or the panel stays empty.
