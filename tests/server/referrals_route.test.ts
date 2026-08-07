// Unit coverage for the referrals route layer (server/card_routes.ts).
//
// GET /api/referrals is guarded by the shared activeGuard + referralsHandler,
// which Promise.all([referralCountForAccount, primarySlugForAccount]) into a
// { count, slug } 200 (byte-identical to the legacy inline arm), and 401s a
// no-bearer request byte-identical to its characterization golden.
//
// server/db.ts builds a pg Pool at module load and throws if DATABASE_URL is unset;
// card_routes.ts imports it, so set a dummy URL. The pool never connects: the
// referrals db reads are mocked and the guard reads come through the
// setCardDbForTests seam.
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5433/wildhaven_phase14_units';

import { readFileSync } from 'node:fs';
import type * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCardDbForTests, routes, setCardDbForTests } from '../../server/card_routes';
import type { AccountModerationStatus } from '../../server/db';
import { compose } from '../../server/http/compose';
import { ERROR_CODES } from '../../server/http/error_codes';
import { withErrors } from '../../server/http/middleware/with_errors';
import type { Method, Middleware } from '../../server/http/types';
import { type FakeRes, fakeCtx, stableStringify } from './helpers';

// The referralsHandler self-reads referralCountForAccount + primarySlugForAccount off
// db.ts directly (not through the card_routes.ts guard seam), so mock those two exports.
// The ...actual spread keeps every other db export real; the guard's bearer/moderation
// reads come through the setCardDbForTests seam, so they are unaffected by this mock.
vi.mock('../../server/db', async (importActual) => {
  const actual = await importActual<typeof import('../../server/db')>();
  return {
    ...actual,
    referralCountForAccount: vi.fn(async () => 3),
    primarySlugForAccount: vi.fn(async () => 'abc'),
  };
});

// A well-formed bearer header (64 lowercase-hex, matching wallet.ts BEARER_PATTERN).
const BEARER = `Bearer ${'a'.repeat(64)}`;

type DbOverrides = Parameters<typeof setCardDbForTests>[0];

// ---------------------------------------------------------------------------
// Local builders (redefined per-file, mirroring tests/server/account.test.ts).
// ---------------------------------------------------------------------------

/** A not-locked moderation status (the AccountModerationStatus happy-path shape). */
function modStatus(overrides: Partial<AccountModerationStatus> = {}): AccountModerationStatus {
  return {
    locked: false,
    banned: false,
    suspendedUntil: null,
    reason: '',
    message: '',
    chatMutedUntil: null,
    chatStrikes: 0,
    ...overrides,
  };
}

/** A fake accountAndScopeForToken resolving to account 7 with the given scope. */
function scopeOf(scope: 'read' | 'full') {
  return async () => ({ accountId: 7, scope });
}

/** Read status/body/raw-body/content-type/retry-after off the fakeCtx's FakeRes. */
function readRes(res: http.ServerResponse): {
  status: number;
  body: unknown;
  raw: string;
  contentType: string | undefined;
  retryAfter: string | number | string[] | undefined;
} {
  const fake = res as unknown as FakeRes;
  return {
    status: fake.statusCode,
    body: fake.body ? JSON.parse(fake.body) : undefined,
    raw: fake.body,
    contentType: fake.headers['content-type'] as string | undefined,
    retryAfter: fake.headers['retry-after'],
  };
}

/** Grab a route by method + path (paths repeat across methods, so both are needed). */
function routeFor(method: Method, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`no route ${method} ${path}`);
  return route;
}

/** The shared active guard, pulled off a guarded route so its identity can be compared. */
const activeGuard = routeFor('GET', '/api/referrals').middleware?.[0] as Middleware;

/** Seed the guard db bundle (bearer + moderation) for a full route chain. */
function authedDb(overrides: DbOverrides = {}): void {
  setCardDbForTests({
    accountAndScopeForToken: scopeOf('full'),
    moderationStatusForAccount: async () => modStatus(),
    ...overrides,
  });
}

/** Load a characterization golden (status + raw body string) by its main-surface name. */
function fixture(name: string): { status: number; body: string } {
  const url = new URL(`./fixtures/main/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** Drive a full route chain (its real middleware + handler) under withErrors. */
async function runRoute(
  method: Method,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const route = routeFor(method, path);
  let reached = false;
  const terminal: Middleware = async (c) => {
    reached = true;
    await route.handler(c);
  };
  const ctx = fakeCtx({ method, url: path, headers: opts.headers, body: opts.body });
  const stack: Middleware[] = [
    withErrors({ surface: 'problem+json' }),
    ...(route.middleware ?? []),
    terminal,
  ];
  await compose(stack)(ctx);
  return { reached, ...readRes(ctx.res) };
}

afterEach(() => {
  resetCardDbForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Route table wiring.
// ---------------------------------------------------------------------------

describe('referrals route table', () => {
  it('registers GET /api/referrals on the api surface', () => {
    const route = routeFor('GET', '/api/referrals');
    expect(route.surface).toBe('api');
    expect(typeof route.handler).toBe('function');
  });

  it('gates /api/referrals with the shared activeGuard', () => {
    const referrals = routeFor('GET', '/api/referrals');
    expect(referrals.middleware).toHaveLength(1);
    expect(referrals.middleware?.[0]).toBe(activeGuard);
  });
});

describe('GET /api/referrals (activeGuard)', () => {
  it('401s a request with no bearer, byte-identical to the golden fixture', async () => {
    const r = await runRoute('GET', '/api/referrals');
    const fx = fixture('referrals_get_noauth_401');
    expect(r.status).toBe(fx.status);
    // The golden body canonicalizes key order (code before error); the raw emit is
    // insertion order, so canonicalize the raw the same way before the byte-compare.
    expect(stableStringify(JSON.parse(r.raw))).toBe(fx.body);
    expect(r.contentType).toBe('application/json');
    // A missing bearer short-circuits at the guard: the handler never runs.
    expect(r.reached).toBe(false);
  });

  it('200s { count, slug } for a full bearer + passing guard seam', async () => {
    // The guard seam resolves the bearer to a full, non-locked account; the referrals
    // db reads are the mocked referralCountForAccount -> 3 and primarySlugForAccount ->
    // 'abc', so referralsHandler serializes the exact legacy { count, slug } shape.
    authedDb();
    const r = await runRoute('GET', '/api/referrals', { headers: { authorization: BEARER } });
    expect(r.reached).toBe(true);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe('application/json');
    expect(r.body).toEqual({ count: 3, slug: 'abc' });
  });
});

// ---------------------------------------------------------------------------
// The stable code this migration reused (no catalog append).
// ---------------------------------------------------------------------------

describe('rate_limit.exceeded stable code (no catalog append)', () => {
  it('is already a registered ErrorCode with a retryAfterSeconds param', () => {
    // The coded 429 the card limiter throws reuses this existing code; the
    // migration appended nothing to the catalog. Its single param is the Retry-After source.
    expect('rate_limit.exceeded' in ERROR_CODES).toBe(true);
    expect(ERROR_CODES['rate_limit.exceeded'].params).toEqual(['retryAfterSeconds']);
  });
});
