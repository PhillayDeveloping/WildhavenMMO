import { describe, expect, it } from 'vitest';
import {
  diagnose,
  inspectConnectionString,
  isLocalHost,
  judgeHeadroom,
  safeUrl,
} from '../scripts/lib/db_check_core.mjs';

// The pure half of the DATABASE_URL preflight (scripts/db_check.mjs). These are
// the decisions an operator pointing the server at a hosted Postgres actually
// reads, so they are pinned without needing a database.

describe('safeUrl', () => {
  it('redacts the password, which is the whole reason the URL can be printed', () => {
    expect(
      safeUrl('postgresql://postgres.abc:hunter2@aws-0-eu.pooler.supabase.com:5432/postgres'),
    ).toBe('postgresql://postgres.abc:****@aws-0-eu.pooler.supabase.com:5432/postgres');
  });

  it('keeps the parts an operator needs to recognise their own string', () => {
    const out = safeUrl(
      'postgresql://postgres.myref:pw@aws-0-eu.pooler.supabase.com:5432/postgres?sslmode=require',
    );
    expect(out).toContain('postgres.myref');
    expect(out).toContain('pooler.supabase.com:5432');
    expect(out).toContain('sslmode=require');
    expect(out).not.toContain('pw@');
  });

  it('does not throw on a malformed string, and leaks nothing when it gives up', () => {
    expect(safeUrl('not a url')).toBe('(unparseable connection string)');
  });

  it('handles a passwordless URL without inventing one', () => {
    expect(safeUrl('postgres://someone@127.0.0.1:5433/db')).not.toContain('****');
  });
});

describe('isLocalHost', () => {
  it.each(['localhost', '127.0.0.1', '::1', '[::1]'])('treats %s as local', (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it('treats a pooler host as remote, which is what turns the TLS warning on', () => {
    expect(isLocalHost('aws-0-eu-central-1.pooler.supabase.com')).toBe(false);
  });
});

describe('inspectConnectionString', () => {
  it('passes a well-formed remote URL asking for verified TLS', () => {
    expect(
      inspectConnectionString(
        'postgresql://postgres.ref:pw@aws-0-eu.pooler.supabase.com:5432/postgres?sslmode=require',
      ),
    ).toEqual([]);
  });

  it('warns when a REMOTE database is addressed with no sslmode at all', () => {
    const notes = inspectConnectionString('postgresql://u:p@db.example.com:5432/postgres');
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe('warn');
    expect(notes[0].message).toContain('sslmode=require');
  });

  it('stays quiet about TLS for localhost, where plaintext is the normal setup', () => {
    expect(inspectConnectionString('postgres://eastbrook:pw@127.0.0.1:5433/eastbrook')).toEqual([]);
  });

  it('warns that no-verify is a diagnostic, not a way to run', () => {
    const notes = inspectConnectionString(
      'postgresql://u:p@db.example.com:5432/postgres?sslmode=no-verify',
    );
    expect(
      notes.some((n: { message: string }) => /diagnose with, not to run/.test(n.message)),
    ).toBe(true);
  });

  it('fails a string that is not a URL at all', () => {
    expect(inspectConnectionString('postgres//broken')[0].level).toBe('fail');
  });
});

describe('diagnose', () => {
  it('points a bad hostname at the pooler-vs-direct mistake', () => {
    expect(diagnose({ code: 'ENOTFOUND' })).toContain('pooler.supabase.com');
  });

  it('points a refused connection at the local dev database', () => {
    expect(diagnose({ code: 'ECONNREFUSED' })).toContain('npm run db:up');
  });

  it('explains that a timeout is usually the IPv6-only direct connection', () => {
    expect(diagnose({ code: 'ETIMEDOUT' })).toContain('IPv6-only');
  });

  it('translates the SASL failure into the real cause: the username shape', () => {
    // pg reports a wrong password as a SASL error, which names nothing useful.
    expect(
      diagnose({ message: 'SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string' }),
    ).toContain('postgres.<project-ref>');
    expect(diagnose({ code: '28P01' })).toContain('not the API key');
  });

  it('names the database that Supabase actually uses when the name is wrong', () => {
    expect(diagnose({ code: '3D000' })).toContain('postgres');
  });

  it('explains a certificate failure as verification, not encryption, and ranks the causes', () => {
    const out = diagnose({ message: 'self signed certificate in certificate chain' });
    expect(out).toContain('FULL verification');
    expect(out).toContain('proxy');
    // The general branch still has to point at the private-root case, which is
    // the likeliest cause and the only one with an exact fix.
    expect(out).toContain('DATABASE_CA_CERT');
    // The escape hatch must be offered as a diagnostic only.
    expect(out).toContain('never to run');
  });

  it('names the private root and the in-repo fix when the code says the root is unknown', () => {
    // What connecting to a Supabase Session Pooler over sslmode=require actually
    // returns. The chain is well-formed; the root is simply not publicly trusted,
    // so the generic "certificate" wording sends the operator hunting the wrong bug.
    const out = diagnose({ code: 'SELF_SIGNED_CERT_IN_CHAIN' });
    expect(out).toContain('Supabase Root 2021 CA');
    // The remedy .env CAN carry, offered first because it is the one that
    // travels with the repo (scripts/lib/db_ssl.mjs hands the CA to pg itself).
    expect(out).toContain('DATABASE_CA_CERT');
    // The machine-wide alternative still has to be named, together with the
    // reason .env cannot carry THAT one: a reader who knows only
    // NODE_EXTRA_CA_CERTS otherwise puts it in .env and watches it do nothing.
    expect(out).toContain('NODE_EXTRA_CA_CERTS');
    expect(out).toContain('--env-file');
    expect(out).toContain('process.loadEnvFile()');
    expect(out).toContain('never to run');
  });

  it('does not mistake an unknown root for a broken certificate', () => {
    // The two certificate arms must stay distinguishable: the private-root case
    // has one exact remedy, the general case is a ranked list of guesses.
    const root = diagnose({ code: 'SELF_SIGNED_CERT_IN_CHAIN' });
    const generic = diagnose({ message: 'unable to verify the first certificate' });
    expect(root).not.toBe(generic);
    expect(root).not.toContain('In order of likelihood');
    expect(generic).not.toContain('Supabase Root 2021 CA');
  });

  it('falls through to the raw message rather than swallowing an unknown error', () => {
    expect(diagnose({ message: 'something entirely new' })).toBe('something entirely new');
  });
});

describe('judgeHeadroom', () => {
  it('fails when the cap cannot seat even one realm', () => {
    // The failure this exists to catch: a small hosted plan silently below the
    // pool size, which shows up as connection errors under load, not at boot.
    const v = judgeHeadroom(8, 10);
    expect(v.level).toBe('fail');
    expect(v.needed).toBe(11);
    expect(v.message).toContain('one realm needs 11');
  });

  it('counts the boot client, not just the pool', () => {
    // Exactly pool-size available is NOT enough: ensureSchema opens its own
    // non-pool client, so an off-by-one here would pass a config that hangs.
    expect(judgeHeadroom(10, 10).level).toBe('fail');
    expect(judgeHeadroom(11, 10).level).not.toBe('fail');
  });

  it('warns on a tight but workable cap', () => {
    expect(judgeHeadroom(15, 10).level).toBe('warn');
  });

  it('passes a stock container cap', () => {
    expect(judgeHeadroom(100, 10).level).toBe('ok');
  });

  it('respects a lowered pool size, so shrinking the pool is a real fix', () => {
    expect(judgeHeadroom(8, 10).level).toBe('fail');
    expect(judgeHeadroom(8, 3).level).toBe('ok');
  });

  it('warns rather than failing when max_connections could not be read', () => {
    expect(judgeHeadroom(Number.NaN, 10).level).toBe('warn');
  });
});
