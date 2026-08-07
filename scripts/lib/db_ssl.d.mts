// Hand-written types for db_ssl.mjs, so server/db.ts and a type-checked Vitest
// suite can import it directly (the scripts/ convention: a .d.mts beside the .mjs).

/** Env key holding a filesystem path to the PEM-encoded root certificate. */
export const DATABASE_CA_CERT_ENV: 'DATABASE_CA_CERT';

export interface DatabaseConnectionOptions {
  /** The connection string to hand pg, with a verifying sslmode removed. */
  connectionString: string;
  /** The TLS material, present only when a CA was configured and applies. */
  ssl?: { ca: string };
  /** The configured certificate path, for logging. Absent when unset. */
  caPath?: string;
  /** Why a configured certificate was NOT applied, when that is the case. */
  ignoredReason?: string;
}

/**
 * Resolve the pg connection options for a database URL, folding in the CA
 * certificate named by DATABASE_CA_CERT. Throws when that path is set but
 * cannot be read or is not PEM.
 */
export function resolveDatabaseSsl(
  databaseUrl: string,
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): DatabaseConnectionOptions;
