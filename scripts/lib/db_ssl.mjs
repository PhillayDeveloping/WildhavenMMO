// Turns DATABASE_URL plus an optional CA-certificate path into the connection
// options `pg` actually needs. Pure and dependency-free so both the server
// (server/db.ts) and the preflight (scripts/db_check.mjs) share ONE
// implementation: db_check exists to prove the server can use a database, so
// anything the two resolve differently would make the check a lie.
//
// Why this module exists at all. A hosted Postgres often chains up to a PRIVATE
// root that no OS trust store carries (Supabase's pooler ends at "Supabase Root
// 2021 CA"), so every connection fails SELF_SIGNED_CERT_IN_CHAIN even though the
// chain is well-formed. Node's own answer, NODE_EXTRA_CA_CERTS, is read once
// before the process starts, so `.env` structurally CANNOT carry it: neither
// --env-file nor process.loadEnvFile() runs early enough. That left the CA as a
// machine-level environment variable, invisible from the repo and easy to lose
// on a new machine or a second worktree. Handing the certificate to pg directly
// keeps the whole configuration inside .env.
//
// The load-bearing detail, measured rather than assumed. pg builds its config as
// `Object.assign({}, config, parse(config.connectionString))` (pg/lib/
// connection-parameters.js), so the parsed connection string OVERRIDES the
// caller's options. With `?sslmode=require` present, pg-connection-string
// returns `ssl: {}` and an explicit `ssl: { ca }` is silently discarded, leaving
// verification against the system trust store and the same failure as before.
// Dropping the sslmode parameter is what lets the CA survive; `ssl: { ca }` is
// not a weakening, it is the same verify-full posture (Node defaults
// rejectUnauthorized to true, and pg sets `servername` so the hostname is
// checked) against a root we name explicitly.

import { readFileSync } from 'node:fs';

/** Env key holding a filesystem path to the PEM-encoded root certificate. */
export const DATABASE_CA_CERT_ENV = 'DATABASE_CA_CERT';

// sslmode values that ask for a VERIFIED connection, and so are the ones a
// supplied CA is meant to serve. Note `prefer` and `require` are here because
// the pinned pg-connection-string treats them as verify-full aliases; that is
// the behavior this repo runs against, not libpq's weaker historical meaning.
const VERIFYING_SSL_MODES = new Set(['prefer', 'require', 'verify-ca', 'verify-full']);

// sslmode values where the operator has deliberately opted OUT of verification.
// A CA path is meaningless against these, and quietly upgrading the connection
// would override an explicit choice, so they win and the certificate is ignored.
const OPT_OUT_SSL_MODES = new Set(['disable', 'no-verify']);

/**
 * Resolve the pg connection options for a database URL.
 *
 * @param {string} databaseUrl the raw DATABASE_URL
 * @param {Record<string, string | undefined>} env process.env, or a fake
 * @param {(path: string) => string} readFile reads the PEM file as utf8
 * @returns {{ connectionString: string, ssl?: { ca: string }, caPath?: string, ignoredReason?: string }}
 */
export function resolveDatabaseSsl(databaseUrl, env, readFile) {
  const caPath = String(env[DATABASE_CA_CERT_ENV] ?? '').trim();
  if (!caPath) return { connectionString: databaseUrl };

  const sslMode = readSslMode(databaseUrl);
  if (sslMode !== null && OPT_OUT_SSL_MODES.has(sslMode)) {
    // Deliberate opt-out: report it rather than silently doing nothing, so an
    // operator who set both never has to guess which one took effect.
    return {
      connectionString: databaseUrl,
      caPath,
      ignoredReason: `sslmode=${sslMode} disables certificate verification, so ${DATABASE_CA_CERT_ENV} is unused`,
    };
  }

  const ca = readCaFile(caPath, readFile);
  // Only a VERIFYING mode has to go: it is the one that would clobber our ssl
  // option. A URL with no sslmode at all is left byte-identical.
  const connectionString =
    sslMode !== null && VERIFYING_SSL_MODES.has(sslMode) ? stripSslMode(databaseUrl) : databaseUrl;
  return { connectionString, ssl: { ca }, caPath };
}

/**
 * resolveDatabaseSsl bound to the real filesystem. The reader stays injectable
 * on the function above so the rules are unit-tested without touching disk;
 * this is what every caller actually uses.
 *
 * @param {string} databaseUrl
 * @param {Record<string, string | undefined>} [env]
 */
export function databaseConnectionOptions(databaseUrl, env = process.env) {
  return resolveDatabaseSsl(databaseUrl, env, (p) => readFileSync(p, 'utf8'));
}

/**
 * Just the pair a pg Pool or Client constructor takes, for the operator scripts
 * that build their own connection. Without this each one silently reverts to
 * the system trust store and fails against a hosted database behind a private
 * root, which is exactly the trap this module exists to close.
 *
 * @param {string} databaseUrl
 * @param {Record<string, string | undefined>} [env]
 */
export function pgConnectionConfig(databaseUrl, env = process.env) {
  const resolved = databaseConnectionOptions(databaseUrl, env);
  return resolved.ssl
    ? { connectionString: resolved.connectionString, ssl: resolved.ssl }
    : { connectionString: resolved.connectionString };
}

function readCaFile(caPath, readFile) {
  let pem;
  try {
    pem = readFile(caPath);
  } catch (err) {
    // Fail fast and loud. The alternative is the symptom this module exists to
    // remove: a connection that retries forever with a certificate error that
    // never names the missing file.
    throw new Error(
      `${DATABASE_CA_CERT_ENV} points at ${caPath}, which could not be read: ${err?.message ?? err}`,
    );
  }
  if (!/-----BEGIN CERTIFICATE-----/.test(pem)) {
    // A DER file or an HTML error page saved by mistake connects nowhere and
    // reports it as a TLS failure, which sends the reader down the wrong path.
    throw new Error(
      `${DATABASE_CA_CERT_ENV} points at ${caPath}, which is not a PEM certificate (no BEGIN CERTIFICATE block)`,
    );
  }
  return pem;
}

/** The sslmode query parameter, lowercased, or null when absent or unparseable. */
function readSslMode(databaseUrl) {
  const url = parseUrl(databaseUrl);
  if (!url) return null;
  const raw = url.searchParams.get('sslmode');
  return raw === null ? null : raw.trim().toLowerCase();
}

/** The same URL with its sslmode parameter removed. */
function stripSslMode(databaseUrl) {
  const url = parseUrl(databaseUrl);
  if (!url) return databaseUrl;
  url.searchParams.delete('sslmode');
  return url.toString();
}

// The keyword form ("host=... user=...") is not a URL and is not a configuration
// this repo documents; leave such a string untouched rather than throwing.
function parseUrl(databaseUrl) {
  try {
    return new URL(databaseUrl);
  } catch {
    return null;
  }
}
