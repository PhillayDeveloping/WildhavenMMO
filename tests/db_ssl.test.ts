// The connection-option resolver both server/db.ts and scripts/db_check.mjs
// build their pg clients from. The load-bearing behavior is the sslmode strip:
// pg merges `parse(connectionString)` OVER the caller's options, so an explicit
// ssl.ca is silently discarded while sslmode is present, and the connection
// falls back to the system trust store: the exact failure this module removes.
import { describe, expect, it } from 'vitest';
import { DATABASE_CA_CERT_ENV, resolveDatabaseSsl } from '../scripts/lib/db_ssl.mjs';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const URL_REQUIRE = 'postgresql://u:p@db.example.com:5432/postgres?sslmode=require';
const URL_PLAIN = 'postgresql://u:p@db.example.com:5432/postgres';

/** readFile stub that serves one path and throws for anything else. */
function reader(path: string, contents: string) {
  return (requested: string) => {
    if (requested !== path)
      throw new Error(`ENOENT: no such file or directory, open '${requested}'`);
    return contents;
  };
}

describe('resolveDatabaseSsl', () => {
  it('leaves the connection string untouched and attaches no ssl when no CA is configured', () => {
    const out = resolveDatabaseSsl(URL_REQUIRE, {}, () => {
      throw new Error('must not read any file');
    });
    expect(out.connectionString).toBe(URL_REQUIRE);
    expect(out.ssl).toBeUndefined();
    expect(out.caPath).toBeUndefined();
  });

  it('treats a blank or whitespace-only CA path as unset', () => {
    for (const blank of ['', '   ', '\t']) {
      const out = resolveDatabaseSsl(URL_REQUIRE, { [DATABASE_CA_CERT_ENV]: blank }, () => {
        throw new Error('must not read any file');
      });
      expect(out.connectionString).toBe(URL_REQUIRE);
      expect(out.ssl).toBeUndefined();
    }
  });

  it('drops sslmode so the supplied CA survives pg config merging', () => {
    const out = resolveDatabaseSsl(
      URL_REQUIRE,
      { [DATABASE_CA_CERT_ENV]: '/certs/root.crt' },
      reader('/certs/root.crt', PEM),
    );
    // The strip is the whole point: with sslmode present pg would overwrite our
    // ssl option with the parsed `{}` and verify against the system trust store.
    expect(out.connectionString).not.toContain('sslmode');
    expect(out.ssl).toEqual({ ca: PEM });
    expect(out.caPath).toBe('/certs/root.crt');
    // Only sslmode goes. Host, port, database, and credentials must survive.
    const url = new URL(out.connectionString);
    expect(url.hostname).toBe('db.example.com');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/postgres');
    expect(url.username).toBe('u');
  });

  it.each(['prefer', 'require', 'verify-ca', 'verify-full', 'VERIFY-FULL', ' Require '])(
    'strips the verifying sslmode %j',
    (mode) => {
      const out = resolveDatabaseSsl(
        `postgresql://u:p@db.example.com:5432/postgres?sslmode=${encodeURIComponent(mode)}`,
        { [DATABASE_CA_CERT_ENV]: '/ca.pem' },
        reader('/ca.pem', PEM),
      );
      expect(out.connectionString).not.toContain('sslmode');
      expect(out.ssl).toEqual({ ca: PEM });
    },
  );

  it('preserves other query parameters while removing sslmode', () => {
    const out = resolveDatabaseSsl(
      'postgresql://u:p@db.example.com:5432/postgres?sslmode=require&application_name=wildhaven&connect_timeout=10',
      { [DATABASE_CA_CERT_ENV]: '/ca.pem' },
      reader('/ca.pem', PEM),
    );
    const params = new URL(out.connectionString).searchParams;
    expect(params.get('sslmode')).toBeNull();
    expect(params.get('application_name')).toBe('wildhaven');
    expect(params.get('connect_timeout')).toBe('10');
  });

  it('attaches the CA to a URL that carries no sslmode at all, without rewriting it', () => {
    const out = resolveDatabaseSsl(
      URL_PLAIN,
      { [DATABASE_CA_CERT_ENV]: '/ca.pem' },
      reader('/ca.pem', PEM),
    );
    expect(out.connectionString).toBe(URL_PLAIN);
    expect(out.ssl).toEqual({ ca: PEM });
  });

  it.each(['disable', 'no-verify'])(
    'lets an explicit sslmode=%s win over the CA, and says so',
    (mode) => {
      const out = resolveDatabaseSsl(
        `postgresql://u:p@db.example.com:5432/postgres?sslmode=${mode}`,
        { [DATABASE_CA_CERT_ENV]: '/ca.pem' },
        () => {
          throw new Error('must not read the certificate for an opt-out mode');
        },
      );
      expect(out.connectionString).toBe(
        `postgresql://u:p@db.example.com:5432/postgres?sslmode=${mode}`,
      );
      expect(out.ssl).toBeUndefined();
      // Silence would leave an operator who set both guessing which one applied.
      expect(out.ignoredReason).toContain(mode);
      expect(out.ignoredReason).toContain(DATABASE_CA_CERT_ENV);
    },
  );

  it('throws naming the path when the certificate cannot be read', () => {
    expect(() =>
      resolveDatabaseSsl(
        URL_REQUIRE,
        { [DATABASE_CA_CERT_ENV]: 'E:/certs/missing.crt' },
        reader('/other.pem', PEM),
      ),
    ).toThrow(/E:\/certs\/missing\.crt/);
  });

  it('throws when the file is not PEM, rather than failing later as a TLS error', () => {
    // A DER download or a saved HTML error page is the realistic mistake here.
    expect(() =>
      resolveDatabaseSsl(
        URL_REQUIRE,
        { [DATABASE_CA_CERT_ENV]: '/ca.der' },
        reader('/ca.der', '\u0030\u0082\u0003 binary'),
      ),
    ).toThrow(/not a PEM certificate/);
  });

  it('leaves a non-URL keyword connection string alone', () => {
    const keyword = 'host=db.example.com user=u dbname=postgres';
    const out = resolveDatabaseSsl(
      keyword,
      { [DATABASE_CA_CERT_ENV]: '/ca.pem' },
      reader('/ca.pem', PEM),
    );
    expect(out.connectionString).toBe(keyword);
    expect(out.ssl).toEqual({ ca: PEM });
  });
});

describe('the pg merge this resolver works around', () => {
  // Resolves the ssl pg would ACTUALLY use for a config, by building a real
  // Client and reading back the parameters it derived. No connection is opened.
  async function effectiveSsl(config: Record<string, unknown>): Promise<unknown> {
    const { Client } = await import('pg');
    const client = new Client(config) as unknown as { connectionParameters: { ssl: unknown } };
    return client.connectionParameters.ssl;
  }

  it('really does discard an explicit ssl option while sslmode is present', async () => {
    // Pinned against the installed pg rather than asserted from its docs: this
    // override is the entire reason the resolver strips sslmode, so if a future
    // pg stops doing it, this failing test is where that gets noticed.
    expect(await effectiveSsl({ connectionString: URL_REQUIRE, ssl: { ca: PEM } })).toEqual({});
  });

  it('keeps the CA once the resolver has stripped sslmode', async () => {
    const stripped = resolveDatabaseSsl(
      URL_REQUIRE,
      { [DATABASE_CA_CERT_ENV]: '/ca.pem' },
      reader('/ca.pem', PEM),
    );
    expect(
      await effectiveSsl({ connectionString: stripped.connectionString, ssl: stripped.ssl }),
    ).toEqual({ ca: PEM });
  });
});
