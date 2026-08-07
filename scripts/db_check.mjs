// Preflight for DATABASE_URL: prove the server can actually use this database
// BEFORE `npm run server` tries to, so a bad connection string fails with one
// clear line instead of a boot-time stack trace mid-schema-build.
//
// Written for the "move the database to a hosted Postgres" path
// (docs/supabase-database.md), where the failure modes are unfamiliar: TLS
// verification against a pooler hostname, a pooler that rejects the account, or
// a plan whose connection cap is under the pool the server will open. It works
// against any Postgres, including the local `npm run db:up` container.
//
// Read-only apart from one temporary table inside a rolled-back transaction,
// which is how it proves the DDL that ensureSchema() runs at boot is permitted.
// Never prints the password.
//
// The decisions live in scripts/lib/db_check_core.mjs so they are unit-tested
// without a database (tests/db_check_core.test.ts); this file is only the IO.

import pg from 'pg';
import {
  diagnose,
  inspectConnectionString,
  isLocalHost,
  judgeHeadroom,
  safeUrl,
} from './lib/db_check_core.mjs';
import { databaseConnectionOptions } from './lib/db_ssl.mjs';

const { Client } = pg;

// The connection options come from the SAME resolver server/db.ts builds its
// pool from, rather than a second reading of the environment. Anything this
// script tolerates that the server does not would make the check a lie.
const DATABASE_URL = (process.env.DATABASE_URL ?? '').trim();
const CONNECT_TIMEOUT_MS = 15_000;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const ok = (msg) => console.log(`${GREEN}ok${OFF}   ${msg}`);
const warn = (msg) => console.log(`${YELLOW}warn${OFF} ${msg}`);
const fail = (msg) => console.log(`${RED}FAIL${OFF} ${msg}`);

const report = ({ level, message }) =>
  level === 'fail' ? fail(message) : level === 'warn' ? warn(message) : ok(message);

async function main() {
  if (!DATABASE_URL) {
    fail('DATABASE_URL is not set. Copy .env.example to .env and set it.');
    process.exit(1);
  }

  const notes = inspectConnectionString(DATABASE_URL);
  if (notes.some((n) => n.level === 'fail')) {
    notes.forEach(report);
    process.exit(1);
  }

  console.log(`${DIM}checking ${safeUrl(DATABASE_URL)}${OFF}`);
  notes.forEach(report);

  const local = isLocalHost(new URL(DATABASE_URL).hostname);

  // Resolve the TLS material before connecting, so an unreadable or non-PEM
  // certificate is reported by name here rather than as a connect failure.
  let connection;
  try {
    connection = databaseConnectionOptions(DATABASE_URL);
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }
  if (connection.ignoredReason) warn(connection.ignoredReason);
  else if (connection.caPath) ok(`Verifying the server certificate against ${connection.caPath}.`);

  const client = new Client({
    connectionString: connection.connectionString,
    ...(connection.ssl ? { ssl: connection.ssl } : {}),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });

  try {
    await client.connect();
  } catch (err) {
    fail('Could not connect.');
    console.log(`     ${diagnose(err)}`);
    process.exit(1);
  }

  let failed = false;
  try {
    const { rows } = await client.query(
      'SELECT current_database() AS db, current_user AS usr, version() AS version',
    );
    const { db, usr, version } = rows[0];
    ok(`Connected as ${usr} to ${db}.`);
    console.log(`     ${DIM}${String(version).split(' on ')[0]}${OFF}`);

    // TLS: report what actually got negotiated rather than what was asked for.
    const tls = client.connection?.stream?.getCipher?.();
    if (tls) ok(`TLS active (${tls.name}).`);
    else if (!local) warn('Connection is NOT encrypted. Add ?sslmode=require.');
    else ok('Unencrypted, which is expected for a local database.');

    // The permission that matters: ensureSchema() runs CREATE TABLE at boot. A
    // read-only or restricted role connects fine and then fails at startup, so
    // prove DDL now, inside a transaction that is always rolled back.
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE wildhaven_preflight_check (id INT)');
      await client.query('ROLLBACK');
      ok('The role may create tables, so ensureSchema() will succeed at boot.');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      failed = true;
      fail(`The role cannot create tables: ${err.message}`);
      console.log(
        '     The server builds its schema at boot, so it needs DDL rights on this database.',
      );
    }

    // Connection headroom. The server opens DB_POOL_MAX_CLIENTS per realm plus a
    // boot client; a hosted plan's cap is usually far below a stock container's.
    const poolMax = Number(process.env.DB_POOL_MAX_CLIENTS) || 10;
    const capRow = await client.query('SHOW max_connections');
    const verdict = judgeHeadroom(Number(capRow.rows[0].max_connections), poolMax);
    report(verdict);
    if (verdict.level === 'fail') {
      failed = true;
      console.log('     Lower DB_POOL_MAX_CLIENTS or move to a plan with a higher cap.');
    }
  } finally {
    await client.end().catch(() => {});
  }

  if (failed) {
    console.log(`\n${RED}Not ready.${OFF} Fix the FAIL lines above, then run this again.`);
    process.exit(1);
  }
  console.log(
    `\n${GREEN}Ready.${OFF} Start the server with \`npm run server\`; it builds the schema on first boot.`,
  );
}

main().catch((err) => {
  fail(`Unexpected error: ${err?.message ?? err}`);
  process.exit(1);
});
