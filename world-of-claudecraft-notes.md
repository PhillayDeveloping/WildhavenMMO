# Wildhaven — Project Notes

Source repo: https://github.com/levy-street/wildhaven
Official site: https://wildhaven.example/

## What it is

A complete classic-era browser MMO (TypeScript + Three.js). One deterministic
sim core (`src/sim/`) drives three hosts from the same code:

- the offline browser client
- the authoritative multiplayer server (Postgres-backed)
- a headless RL environment (Gymnasium bindings for Python)

9 classes with talent specs, 3 open-world zones, ~80 quests, 5 dungeons,
scalable delves, ranked PvP arena, parties/trading/duels, and almost
everything (towns, creatures, icons, sound) generated procedurally at
runtime rather than shipped as assets.

## License — what I can change

- **Code is MIT licensed.** Free to fork, modify, rename, and even
  commercialize. Only requirement: keep the MIT license/copyright notice
  for any original code I keep.
- **Bundled art assets are CC0** (public domain), except the water normal
  maps which are MIT. Also free to use and modify.
- **Not covered by MIT:** the "Wildhaven" name and logos — that's
  branding, not code. If I release a public or commercial version, rename
  and rebrand it to avoid trademark confusion (especially since "Claude"
  is in the name).
- The built-in Solana web3 bit ($WOC token, wallet linking) is purely
  cosmetic/optional and can be stripped out entirely if not wanted.

## Stack notes

- Server: TypeScript, `ws` for WebSockets, Postgres via the standard `pg`
  (node-postgres) driver, driven off a single `DATABASE_URL` env var — not
  hardcoded to the local Docker Postgres container.
- Local dev normally runs Postgres via `npm run db:up` (Docker, port 5433)
  and the server via `npm run server` (port 8787).

## Plan: database on Supabase, server stays local

Goal: the database lives in the cloud (Supabase), the game server (Node
process) still runs on my own PC, started only when I'm actually playing/
hosting.

Because `pg` + `DATABASE_URL` is just standard Postgres underneath,
pointing it at Supabase instead of local Docker should work.

### Setup steps

1. **Create a Supabase project** — free tier is enough to start.
2. **Grab the Session Pooler connection string** (port 5432,
   `pooler.supabase.com` host) from the project's "Connect" button —
   *not* Direct connection (IPv6-only unless paying for the IPv4 add-on)
   and *not* Transaction pooler (meant for short-lived serverless
   connections, doesn't fully support prepared statements).
3. **Set `DATABASE_URL`** in `.env` to that Supabase string. Skip
   `npm run db:up` entirely — no local Postgres/Docker DB needed anymore.
4. **Confirm SSL is enforced** — Supabase requires TLS. Check wherever the
   `pg` Pool/Client gets created in `server/` for an `ssl` option, or make
   sure the connection string includes `?sslmode=require`. Don't assume
   this "just works" without checking.
5. **Run the schema migration once** against the fresh Supabase database
   (check `server/CLAUDE.md` / `DEPLOY.md` for the exact migration
   command/mechanism).
6. **From then on**, just run `npm run server` locally as usual (or the
   server-only Docker container, with the `postgres` service removed from
   `docker-compose.yml`) whenever hosting a session. Characters/accounts
   persist in Supabase even when the server process itself isn't running.

### Open item — revisit later

Moving the database to the cloud does **not** by itself make the local
server reachable to other players. That still needs either port
forwarding + dynamic DNS on my router, or a tunnel (e.g. Cloudflare
Tunnel) — a separate problem to solve before inviting others to join.
