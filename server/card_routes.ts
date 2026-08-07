// Player-card + referral route layer.
//
// This module owns the RouteDef surface for the shareable player-card upload
// (POST /api/card) and the account's referral readout (GET /api/referrals). It
// follows the server/account.ts template:
//  - the bearer + moderation gate is a per-route guard middleware (activeGuard)
//    that mirrors the legacy bearerActiveAccount resolver and writes the legacy
//    { error } bodies, NOT the generic requireAccount middleware (which throws a
//    problem+json HttpError and would break the goldens and the prose-matcher).
//  - the card handler self-reads its body (readBinaryBody), so NO withBody /
//    withRawBody middleware is composed (either would double-consume the stream).
//    The card pre-auth Content-Length over-cap short-circuit (413 + Connection:
//    close, BEFORE auth and before the body is read) is preserved as a dedicated
//    cardContentLengthGuard mirroring the legacy pre-auth check byte-for-byte;
//    it reuses the existing MAX_CARD_BYTES cap via cardUploadContentLengthTooLarge.
//  - the previously-raw { error: 'rate limited' } 429 on the card route becomes a
//    coded 429 on the new path: the limiter is a rateLimit(policy) middleware that
//    throws HttpError(429, 'rate_limit.exceeded', { retryAfterSeconds }), serialized
//    as RFC 9457 problem+json by the withErrors error boundary. The legacy arm keeps
//    the prose body for the flag-off rollback (the rateLimitedBodyToCode known
//    deviation). CARD_UPLOAD_POLICY is a fused ip+account limiter recording both
//    buckets, so it mounts AFTER activeGuard (ctxAccountId is set) and runs exactly
//    once per request.
//  - the card level lookup (game.liveLevelForCharacter) is the one main.ts-local
//    singleton the handlers need; it is INJECTED once at boot via
//    configureCardRuntime, so `export const routes` stays a static array
//    registry.ts can spread. The db.ts reads the guard uses are bundled behind
//    setCardDbForTests for unit tests. The legacy handleApi arms stay in main.ts as
//    the flag-off rollback path until the ladder-deletion PR (next release).

import type http from 'node:http';
import {
  accountAndScopeForToken,
  moderationStatusForAccount,
  primarySlugForAccount,
  referralCountForAccount,
  scopeAllowsMutation,
} from './db';
import { ctxAccountId } from './http/context';
import { CARD_UPLOAD_POLICY, rateLimit } from './http/middleware/rate_limit';
import type { Ctx, Middleware, RouteDef } from './http/types';
import { json, moderationErrorBody } from './http_util';
import { cardUploadContentLengthTooLarge, handleCardUpload } from './player_card';
import { recordUsageMetric } from './provider_usage';

// The exact legacy { error } identities the guard + card pre-auth check emit.
// Named constants so they cannot drift from the bearerActiveAccount / card arms
// they mirror. No em dash appears in any (the legacy strings never used one).
const NOT_AUTHENTICATED = { error: 'not authenticated', code: 'auth.required' } as const;
const READ_ONLY_TOKEN = { error: 'this token is read-only', code: 'auth.forbidden' } as const;
const IMAGE_TOO_LARGE = { error: 'image too large' } as const;

// The bearer token shape: a 64-hex secret behind the "Bearer " scheme. Mirrors
// the regex the legacy bearer* resolvers in server/main.ts use.
const BEARER_PATTERN = /^Bearer ([a-f0-9]{64})$/;

// ---------------------------------------------------------------------------
// Runtime injection. registry.ts spreads the static `routes` array at module
// load, before main.ts has booted the GameServer, so the card handler cannot
// close over `game` directly (that would be a cycle: main -> registry ->
// card_routes -> main). Instead main.ts injects the live level lookup once at
// boot via configureCardRuntime; a request never arrives before that runs. It is
// the exact (characterId) => game.liveLevelForCharacter(characterId) the legacy
// /api/card arm passed to handleCardUpload.
// ---------------------------------------------------------------------------

/** The main.ts game-session hook the card handler needs (the live authoritative level). */
export interface CardGameHooks {
  /** The live Sim level for an online character, or null when it is offline. */
  liveLevelForCharacter(characterId: number): number | null;
}

let runtime: CardGameHooks | null = null;

/** Inject the main.ts game-session hook the card handler needs (boot). */
export function configureCardRuntime(rt: CardGameHooks): void {
  runtime = rt;
}

/** Clear the injected runtime so a unit test can install its own fake. */
export function resetCardRuntimeForTests(): void {
  runtime = null;
}

/** The injected runtime, or a loud failure if a request somehow beat boot wiring. */
function useRuntime(): CardGameHooks {
  if (runtime === null) {
    throw new Error('card runtime is not configured; call configureCardRuntime');
  }
  return runtime;
}

// ---------------------------------------------------------------------------
// Db seam. The bearer-resolution reads the guard uses, bundled once behind a
// test-only setter so the guard can be driven with a fake and no Postgres.
// Production never calls the setter, so REAL_CARD_DB is the only runtime
// binding and it references the exact functions the legacy bearerActiveAccount
// arm calls. scopeAllowsMutation is pure (no DB), so it stays a direct import.
// The card / referral domain functions keep their own direct db.ts imports
// (driven by the existing pg-mock test harnesses); this seam covers only the
// guard code.
// ---------------------------------------------------------------------------

const REAL_CARD_DB = { accountAndScopeForToken, moderationStatusForAccount };
let cardDb = REAL_CARD_DB;

/** Override the card db bundle with a fake (test-only; merges over the real reads). */
export function setCardDbForTests(overrides: Partial<typeof REAL_CARD_DB>): void {
  cardDb = { ...REAL_CARD_DB, ...overrides };
}

/** Restore the real card db bundle after a setCardDbForTests override (test-only). */
export function resetCardDbForTests(): void {
  cardDb = REAL_CARD_DB;
}

// ---------------------------------------------------------------------------
// Bearer guard. activeGuard mirrors bearerActiveAccount (full-session, read-only
// 403, moderation 403). It writes the legacy { error } bodies and short-circuits
// (no next()) on rejection; a missing/malformed bearer 401s WITHOUT a DB call (so
// the no-auth goldens replay DB-free through both dispatch paths).
// ---------------------------------------------------------------------------

/** The raw 64-hex bearer token, or null (no header or bad shape). */
function bearerToken(req: http.IncomingMessage): string | null {
  const m = BEARER_PATTERN.exec(req.headers.authorization ?? '');
  return m ? m[1] : null;
}

// FOLLOW-UP (rule-of-three, filed in docs/api-pipeline/progress.md): this activeGuard
// (with bearerToken + BEARER_PATTERN + NOT_AUTHENTICATED + READ_ONLY_TOKEN) is now the
// THIRD byte-identical copy of the bearerActiveAccount mirror, alongside
// server/characters.ts and server/account.ts. The clean resolution is a shared
// db-seam-parameterized bearer-guard middleware, but extracting it here would touch two
// already-shipped, byte-parity-pinned surfaces that also carry sibling guards (readGuard,
// logoutGuard), so it belongs in a dedicated packet step (a natural fit alongside the
// ladder-deletion follow-up PR), NOT this small card migration. Do NOT add a 4th copy
// on any future surface.
/** Mutating + account-scoped gate (mirrors server/main.ts bearerActiveAccount). */
const activeGuard: Middleware = async (ctx, next) => {
  const token = bearerToken(ctx.req);
  const info = token === null ? null : await cardDb.accountAndScopeForToken(token);
  if (info === null) {
    json(ctx.res, 401, NOT_AUTHENTICATED);
    return;
  }
  if (!scopeAllowsMutation(info.scope)) {
    json(ctx.res, 403, READ_ONLY_TOKEN);
    return;
  }
  const status = await cardDb.moderationStatusForAccount(info.accountId);
  if (status.locked) {
    json(ctx.res, 403, moderationErrorBody(status));
    return;
  }
  ctx.account = { accountId: info.accountId, scope: info.scope };
  await next();
};

/**
 * Card pre-auth Content-Length gate. Mirrors the legacy /api/card arm exactly: it
 * records the publish request, and when the declared Content-Length exceeds the
 * existing MAX_CARD_BYTES cap it short-circuits 413 { error: 'image too large' }
 * with Connection: close (and shouldKeepAlive = false) BEFORE the auth guard and
 * before any body is read, so a huge upload is rejected without a DB lookup and
 * the socket is told to close rather than keep streaming. Uses the existing named
 * cap via cardUploadContentLengthTooLarge (no new literal).
 */
const cardContentLengthGuard: Middleware = async (ctx, next) => {
  recordUsageMetric('card.publish.request');
  if (cardUploadContentLengthTooLarge(ctx.req)) {
    recordUsageMetric('card.publish.rejected');
    ctx.res.shouldKeepAlive = false;
    ctx.res.setHeader('Connection', 'close');
    json(ctx.res, 413, IMAGE_TOO_LARGE);
    return;
  }
  await next();
};

// ---------------------------------------------------------------------------
// Thin Ctx handlers. Each starts after its guard chain has run, resolves the
// account from the Ctx, and delegates to the matching domain function UNCHANGED,
// so the response bytes are identical to the legacy arm.
// ---------------------------------------------------------------------------

/** POST /api/card: publish a shareable player-card PNG (binary body; self-read). */
async function cardHandler(ctx: Ctx): Promise<void> {
  return handleCardUpload(ctx.req, ctx.res, ctxAccountId(ctx), (characterId) =>
    useRuntime().liveLevelForCharacter(characterId),
  );
}

/** GET /api/referrals: the account's referral count + primary card slug. */
async function referralsHandler(ctx: Ctx): Promise<void> {
  const accountId = ctxAccountId(ctx);
  const [count, slug] = await Promise.all([
    referralCountForAccount(accountId),
    primarySlugForAccount(accountId),
  ]);
  return json(ctx.res, 200, { count, slug });
}

// ---------------------------------------------------------------------------
// The route table. registry.ts spreads this into apiRoutes. Under API_DISPATCH
// 'new' the registry dispatcher serves these via the onion; the legacy handleApi
// arms stay in main.ts for the flag-off rollback until the ladder-deletion PR.
// Both routes carry [activeGuard]; the card route additionally runs
// cardContentLengthGuard FIRST (the pre-auth 413 short-circuit) and the fused
// ip+account limiter AFTER the guard (it needs ctx.account).
// ---------------------------------------------------------------------------

export const routes: RouteDef[] = [
  {
    method: 'POST',
    path: '/api/card',
    surface: 'api',
    middleware: [cardContentLengthGuard, activeGuard, rateLimit(CARD_UPLOAD_POLICY)],
    handler: cardHandler,
    // The card upload is the one registered /api route whose request body is raw
    // bytes (image/png), not JSON: the Content-Type 415 gate exempts it via
    // this classification (the response error envelope stays the surface default).
    meta: { requestBody: 'binary' },
  },
  {
    method: 'GET',
    path: '/api/referrals',
    surface: 'api',
    middleware: [activeGuard],
    handler: referralsHandler,
  },
];
