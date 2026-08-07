// Hand-written types for db_check_core.mjs, so a type-checked Vitest suite can
// import it directly (the scripts/ convention: a .d.mts beside the .mjs).

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckNote {
  level: CheckLevel;
  message: string;
}

export interface HeadroomVerdict extends CheckNote {
  /** Connections one realm needs: the pool plus the boot client. */
  needed: number;
}

/** Redact the password so a connection string is safe to print. */
export function safeUrl(raw: string): string;

/** Is this hostname one of the loopback names where plaintext is expected? */
export function isLocalHost(hostname: string): boolean;

/** Warnings derivable from the connection string alone, before dialling. */
export function inspectConnectionString(raw: string): CheckNote[];

/** Map a driver error onto the thing the operator has to change. */
export function diagnose(err: unknown): string;

/** Does this server have room for a realm at the given pool size? */
export function judgeHeadroom(maxConnections: number, poolMax: number): HeadroomVerdict;
