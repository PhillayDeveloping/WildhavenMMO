# Hosting a realm for friends

Running the server on your own machine so other people can play, with the
database on Supabase (`docs/supabase-database.md`). This is the small-scale
path: a handful of players, no cloud host, no domain purchase required. For the
full production deployment see `DEPLOY.md`, which is a different shape entirely
(EC2, Docker Compose, Ansible, a bundled Postgres).

## The one fact that makes this easy

**The game server serves everything on one port.** `npm run server` (default
8787) answers the built client from `dist/`, the REST API under `/api`, and the
WebSocket world at `/ws`. The client opens its socket against
`location.host`, so whatever address a player reaches the page on is
automatically the address their game connects to.

So there is exactly one thing to expose, and no second host to keep in sync.
Note the consequence: `npm run dev` (Vite on :5173) is a development
convenience that proxies to :8787. Players never touch it. What you expose is
the built client, which means you must run `npm run build` after any change you
want them to see.

## Step 1: build and run

```bash
npm run build
```

```bash
npm run server
```

Check `npm run db:check` first if the database is new; it fails with one clear
line instead of a boot-time stack trace.

## Step 2: prove it works on your own network

Before touching any router or tunnel, confirm the server is reachable from a
second device on your LAN. Find your machine's local address (`ipconfig` on
Windows), then from a phone or another computer open `http://<that-address>:8787`.

If that works, everything that follows is only about reaching the same port
from outside. If it does not, it is a local firewall prompt you dismissed, not
a networking problem worth solving with a tunnel.

## Step 3: choose how the outside reaches you

### Option A: a tunnel (recommended)

A tunnel process on your machine makes an outbound connection to a provider,
which then serves your realm on a public hostname. Nothing is opened on your
router, your home IP is not published, and you get HTTPS without buying a
certificate. Cloudflare Tunnel's free tier is the usual choice; `cloudflared
tunnel --url http://localhost:8787` prints a hostname and is running.

The costs are real and worth knowing: a quick tunnel's hostname changes every
time you restart it (a named tunnel on a domain you own is stable), and every
packet goes through a third party.

### Option B: port forwarding

Forward external port 8787 to your machine's LAN address on your router, and
add dynamic DNS if your ISP changes your address. This keeps traffic direct,
at the cost of publishing your home IP address to everyone who connects, and
of running plain HTTP unless you also terminate TLS yourself.

If you go this way, put a reverse proxy in front rather than exposing Node
directly, and give it a certificate.

## Step 4: the configuration that changes once you are public

Set these in `.env` before handing out the address.

```
NODE_ENV=production
PUBLIC_ORIGIN=https://your-public-hostname
WEB_ORIGINS=https://your-public-hostname
```

- **`NODE_ENV=production`** turns on the anti-bot Origin guard for
  `/api/login` and `/api/register`. It is what stops a script from farming
  accounts against your realm.
- **`WEB_ORIGINS`** is the one that bites. The guard matches the browser's
  `Origin` header against the request's own `Host`, so a proxy or tunnel
  configured to rewrite `Host` to its upstream leaves nothing to match, and
  every login and registration answers 403 while the site itself loads
  perfectly. It reads exactly like wrong credentials. Naming your public origin
  here makes the match explicit and immune to whatever the proxy does with
  headers. (A proxy that forwards `X-Forwarded-Host` instead needs no
  configuration; `tests/web_login_guard.test.ts` pins all three cases.)
- **`PUBLIC_ORIGIN`** is what server-generated absolute URLs use, chiefly
  shared player-card pages. Unset, a shared link points nowhere useful.

Optional but worth doing once strangers can reach the address:

- **Turnstile** (`TURNSTILE_SECRET` plus a `VITE_TURNSTILE_SITEKEY` at build
  time) gates registration behind Cloudflare's bot challenge. Note the site key
  is inlined at BUILD time, not read at runtime, so it has to be set when you
  run `npm run build`.
- **`MAX_PLAYERS_PER_REALM`** defaults to 5000, which is far above what a home
  machine will serve. Set a number you actually want to admit.
- **Outbound email.** Until it is configured, a player who forgets their
  password has no way back into their account: see the block in `.env.example`
  and verify with `npm run email:check <address>`.

## What stays your problem

- **`ALLOW_DEV_COMMANDS` must never be set here.** It enables the full cheat
  set (level, teleport, item spawning) for anyone who connects.
- **Your machine is the realm.** When it sleeps, reboots, or loses its network,
  everyone is disconnected. Characters are safe (the server autosaves every 30
  seconds and on shutdown, and the database is not on your machine), but the
  world is gone until you start it again.
- **Restarts drop players.** `server/internal.ts` exposes a restart-countdown
  endpoint so they get a warning first; it is gated by
  `RESTART_COUNTDOWN_SECRET`.
