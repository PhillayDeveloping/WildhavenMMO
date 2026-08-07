// Pure decision core for the DATABASE_URL preflight (scripts/db_check.mjs).
//
// Split out so the parts that decide WHAT TO SAY are unit-testable without a
// database: the connection-string warnings, the driver-error diagnosis, and the
// connection-headroom verdict. The script itself keeps only the IO.

/** Redact the password so a connection string is safe to print. */
export function safeUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return '(unparseable connection string)';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(hostname);
}

/**
 * Warnings derivable from the connection string alone, before dialling.
 * Returns [] for a well-formed remote URL that asks for verified TLS.
 */
export function inspectConnectionString(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return [{ level: 'fail', message: 'DATABASE_URL is not a valid URL.' }];
  }
  const out = [];
  const sslmode = u.searchParams.get('sslmode');
  const local = isLocalHost(u.hostname);
  if (!local && !sslmode) {
    out.push({
      level: 'warn',
      message:
        'No sslmode in the connection string and this is not localhost. Append ?sslmode=require so the connection is encrypted and verified.',
    });
  }
  if (sslmode === 'no-verify') {
    out.push({
      level: 'warn',
      message:
        'sslmode=no-verify skips certificate verification. Fine to diagnose with, not to run with.',
    });
  }
  return out;
}

/**
 * Map a driver error onto the thing the operator has to change. The raw pg
 * messages are famously unhelpful here ("self signed certificate in certificate
 * chain" for a corporate proxy, "SASL" for a wrong password), and every one of
 * these is a failure mode of pointing the server at a hosted Postgres.
 */
export function diagnose(err) {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? err ?? '');
  if (code === 'ENOTFOUND') {
    return 'Host not found. Check the hostname; for Supabase use the Session Pooler host (pooler.supabase.com), not the direct db.<ref>.supabase.co one.';
  }
  if (code === 'ECONNREFUSED') {
    return 'Connection refused. Nothing is listening there. If you meant the local dev database, start it with `npm run db:up`.';
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) {
    return 'Timed out. A firewall or the wrong port. Supabase Session Pooler is port 5432; the direct connection is IPv6-only unless you pay for the IPv4 add-on.';
  }
  if (code === '28P01' || /password authentication failed|SASL/i.test(msg)) {
    return 'Authentication rejected. For Supabase the username is postgres.<project-ref>, not plain postgres, and the password is the database password (not the API key).';
  }
  if (code === '3D000') {
    return 'That database does not exist on the server. Supabase uses the database name `postgres`.';
  }
  if (/self.signed|unable to verify|certificate/i.test(msg)) {
    return [
      'TLS verification failed. With the pinned pg-connection-string, sslmode=require means FULL verification (chain + hostname), not just encryption.',
      'In order of likelihood: a missing intermediate in the system trust store, a corporate TLS-inspecting proxy, then the certificate itself.',
      'sslmode=no-verify connects while dropping verification: use it to CONFIRM the cause, never to run.',
    ].join('\n     ');
  }
  return msg;
}

/**
 * Does this server have room for a realm? One realm opens DB_POOL_MAX_CLIENTS
 * pooled connections plus one boot client for the schema build.
 */
export function judgeHeadroom(maxConnections, poolMax) {
  const needed = poolMax + 1;
  if (!Number.isFinite(maxConnections)) {
    return { level: 'warn', needed, message: 'Could not read max_connections.' };
  }
  if (maxConnections < needed) {
    return {
      level: 'fail',
      needed,
      message: `max_connections is ${maxConnections} but one realm needs ${needed} (DB_POOL_MAX_CLIENTS=${poolMax} plus a boot client).`,
    };
  }
  if (maxConnections < needed * 2) {
    return {
      level: 'warn',
      needed,
      message: `max_connections is ${maxConnections}; one realm needs ${needed}. That works but leaves little headroom.`,
    };
  }
  return {
    level: 'ok',
    needed,
    message: `max_connections is ${maxConnections}; one realm needs ${needed}.`,
  };
}
