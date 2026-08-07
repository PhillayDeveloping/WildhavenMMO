# Running the database on Supabase

The goal this file serves: the database lives in Supabase, the game server keeps
running on your own machine and is started only when you are actually hosting.
That works because `server/db.ts` talks to plain Postgres through `pg` and reads
one `DATABASE_URL`; nothing is hardcoded to the local Docker container.

Everything below was checked against the code in this repo rather than assumed.

## What the code actually does

Three places open a connection, and **all three pass only `connectionString`**:

| Where | What it is |
|---|---|
| `server/db.ts` `pool` | the request-path pool, `DB_POOL_MAX_CLIENTS` clients (default 10) |
| `server/db.ts` `ensureSchema` | a dedicated non-pool `Client` for boot DDL |
| `server/db.ts` `runConcurrentIndexMigrations` | a second non-pool `Client` |

None of them sets an `ssl` option. That is not a gap: with no explicit `ssl`,
`pg` derives TLS from the `sslmode` in the URL, so putting it in `DATABASE_URL`
covers all three at once.

## Setup

1. **Create a Supabase project.** The free tier is enough to start.

2. **Take the Session Pooler connection string** (port 5432, a
   `pooler.supabase.com` host) from the project's Connect dialog. Not Direct
   connection (IPv6-only without the paid IPv4 add-on) and not the Transaction
   pooler (meant for short-lived serverless connections; it does not fully
   support prepared statements).

3. **Set `DATABASE_URL` in `.env`** to that string, with `?sslmode=require`
   appended. Skip `npm run db:up` entirely: no local Docker Postgres is needed
   any more.

   ```
   DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
   ```

4. **Give Node the Supabase root CA.** This step is required, not optional: without
   it every `sslmode=require` connection fails with `SELF_SIGNED_CERT_IN_CHAIN`.

   Supabase's pooler chains up to `Supabase Root 2021 CA`, a private root that no
   operating system trust store carries because it was never meant to be publicly
   trusted. The chain is well-formed and the hostname matches; the root is simply
   unknown, which Node reports with wording that reads like a broken certificate.

   Download it from the dashboard (Project Settings > Database > SSL Configuration >
   Download certificate) and point `NODE_EXTRA_CA_CERTS` at the file.

   ```bash
   setx NODE_EXTRA_CA_CERTS "C:\path\to\prod-ca-2021.crt"
   ```

   **It has to be in the environment before `node` starts, so `.env` cannot carry
   it.** Node reads this variable at startup, and neither mechanism this repo uses
   runs early enough: not `--env-file` (which `db:check` passes), and not
   `process.loadEnvFile()` in `server/env.ts` (which the server calls at runtime).
   Both were measured, not assumed. `setx` also only affects NEW processes, so
   restart any shell that is already open.

   Worth knowing what this buys and costs: a user-level variable extends the trust
   store for every Node process you run, not just Wildhaven, so Supabase becomes a
   CA those processes trust for any domain. On a machine where Node effectively
   only runs this project that is a reasonable trade. To scope it tighter, set the
   variable per command instead, or pass `ssl: { ca }` at the three connection
   sites (which costs the "connection string only" property above).

5. **Check the string before you start the server.**

   ```bash
   npm run db:check
   ```

   This connects exactly the way `server/db.ts` does (connection string only, no
   `ssl` option), then proves the three things that actually decide whether the
   boot will succeed: TLS negotiated, the role may `CREATE TABLE`, and
   `max_connections` can seat a realm. It never prints your password, and its only
   write is a temporary table inside a rolled-back transaction. A failure names the
   fix rather than the driver error: the pooler-vs-direct hostname mix-up, the
   `postgres.<ref>` username shape, and the TLS-verification causes in likelihood
   order all have their own message.

6. **There is no separate migration command.** `ensureSchema()` runs at boot in
   `server/main.ts`, before the server listens, under a
   `pg_advisory_xact_lock` so concurrent realm processes serialize. Starting the
   server once against the fresh Supabase database creates the schema.

   ```bash
   npm run server
   ```

7. **From then on**, just `npm run server` whenever you are hosting. Characters
   and accounts persist in Supabase even while the server process is stopped.

   Note that `docker-compose.yml` is NOT this path: its `game` service builds a
   `DATABASE_URL` pointing at the bundled `postgres` service and waits on that
   service's health check. Running the server against Supabase means running it
   directly (`npm run server`), which is what this document assumes throughout.

## Two things worth knowing before the first connection

**`sslmode=require` means full verification here, not just encryption.** This
repo pins `pg-connection-string` 2.14.0, where `require`, `prefer`, and
`verify-ca` are all aliases for `verify-full`: the certificate chain is verified
against the system trust store and the hostname is checked. That is the
behavior you want, and it is stricter than libpq's meaning of the same word. The
library prints a deprecation warning saying so, because `pg` 9 will switch these
to libpq semantics. When that upgrade happens, pin the intent explicitly with
`sslmode=verify-full`.

If the connection fails TLS verification rather than authentication, check step 4
first: against Supabase the answer is almost always the missing private root, and
Node names that case exactly (`SELF_SIGNED_CERT_IN_CHAIN`). Only once the root is
in place are the other causes worth chasing, in this order: a missing
intermediate, a corporate TLS-inspecting proxy, and then the certificate itself.
`sslmode=no-verify` will connect but drops verification entirely, so use it to
diagnose, never to run.

**Pool size against Supabase's connection cap.** `DB_POOL_MAX_CLIENTS` defaults
to 10, plus one boot client per realm process. The comment in `server/db.ts`
sizes that against a stock `postgres:16` container (97 usable), not against a
Supabase plan, and the free tier allows far fewer pooler connections than that.
One realm at the default is comfortable; raise the knob only against a measured
pool-exhaustion symptom, and check your plan's limit first.

## Still open: other people connecting to your server

Moving the database to the cloud does not by itself make a locally hosted server
reachable. That still needs either port forwarding plus dynamic DNS on the
router, or a tunnel such as Cloudflare Tunnel. Separate problem, separate
change.
