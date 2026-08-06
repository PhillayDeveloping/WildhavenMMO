// Typed game-server client for the external CLAUDIUM economy service.
//
// CLAUDIUM is a server-authoritative soft currency: ALL peg/price/balance logic
// and verification live in the economy service (a separate repo). The game NEVER
// computes any of it; this module is the game server's proxy to that service. The
// browser hits the game server, the game server hits the service over a
// secret-gated internal API.
//
// GRACEFUL DEGRADATION IS THE CONTRACT. If WOC_ECONOMY_SERVICE_URL or
// WOC_ECONOMY_INTERNAL_SECRET is unset, OR the service is unreachable / errors /
// times out, EVERY function here returns a typed "unavailable" result (balance
// null, empty skus, buy disabled) and NEVER throws up into request handling. The
// game must boot and play with the service OFF.
//
// The functions mirror the service SDK v1 surface; they do NOT recompute any
// value, they only pass through what the service returns.

const SERVICE_TIMEOUT_MS = 5000;

/** Integer Claudium balance for an account, or null when the service is off. */
export interface ClaudiumBalanceResult {
  available: boolean;
  balance: number | null;
}

/**
 * Per-rail price. usdPerClaudium fixes the display peg (1 Claudium = 0.01 USD),
 * and is null when the service is off.
 */
export interface ClaudiumPriceResult {
  rail: string;
  usdPerClaudium: number | null;
}

/** One rung of the SKU ladder. usd/claudium both come from the service. */
export interface ClaudiumSku {
  sku: string;
  usd: number;
  claudium: number;
  stripeConfigured?: boolean;
}

/** The SKU ladder, empty when the service is off. */
export interface ClaudiumSkusResult {
  available: boolean;
  skus: ClaudiumSku[];
}

// Card payment through Stripe is the only purchase rail. The service SDK still
// keys prices and purchases by rail name, so the union is kept as a named type
// rather than inlined: a future rail (another PSP, a platform store) adds a
// member here instead of reshaping every signature.
export type ClaudiumRail = 'stripe';
export type ClaudiumPriceRail = 'stripe';

/** The stripe-rail purchase-intent leg (client uses clientSecret with Stripe.js). */
export interface ClaudiumStripeIntent {
  clientSecret: string;
  publishableKey: string;
}

export interface ClaudiumPurchaseResult {
  ok: boolean;
  purchaseId: string | null;
  rail: ClaudiumRail | null;
  claudium: number | null;
  stripe: ClaudiumStripeIntent | null;
  reason: string | null;
}

export interface ClaudiumSpendResult {
  granted: boolean;
  balance: number | null;
  costClaudium: number | null;
  reason: string | null;
}

export interface ClaudiumHistoryEntry {
  entryId: string;
  accountId: number;
  delta: number;
  reason: string;
  ref: string;
  atMs: number;
}

export interface ClaudiumHistoryResult {
  entries: ClaudiumHistoryEntry[];
}

/** One cosmetic-store row: the item and its Claudium cost, both from the service. */
export interface ClaudiumStoreItem {
  itemId: string;
  name: string;
  kind: 'cosmetic' | 'skin' | 'item';
  costClaudium: number;
  owned: boolean;
}

/** The cosmetic store catalog, empty when the service is off. */
export interface ClaudiumStoreResult {
  available: boolean;
  items: ClaudiumStoreItem[];
}

export interface ClaudiumStripeWebhookResult {
  received: boolean;
}

function serviceUrl(): string {
  return (process.env.WOC_ECONOMY_SERVICE_URL ?? '').trim();
}

function serviceSecret(): string {
  return process.env.WOC_ECONOMY_INTERNAL_SECRET ?? '';
}

/** The service is reachable only when BOTH the URL and the secret are set. */
export function claudiumServiceConfigured(): boolean {
  return serviceUrl() !== '' && serviceSecret() !== '';
}

let loggedOnce = false;
function logFailure(err: unknown): void {
  // Dev-channel only; the request path never sees this. Log once so a persistently
  // down service does not flood the server log every request.
  if (loggedOnce) return;
  loggedOnce = true;
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[claudium] economy service unavailable: ${message}`);
}

interface ServiceRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * The one fetch wrapper. Returns the parsed JSON on a 2xx, or null on any
 * failure (unconfigured, non-2xx, network error, timeout, bad JSON). It NEVER
 * throws: every caller maps a null into its own typed unavailable result.
 */
async function callService<T>(req: ServiceRequest): Promise<T | null> {
  const base = serviceUrl();
  const secret = serviceSecret();
  if (base === '' || secret === '') return null;
  try {
    const url = new URL(req.path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
    const headers: Record<string, string> = { 'x-woc-economy-secret': secret };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
    const res = await fetch(url, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? SERVICE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${req.method} ${req.path} -> ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    logFailure(err);
    return null;
  }
}

export async function claudiumStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string,
): Promise<ClaudiumStripeWebhookResult> {
  const base = serviceUrl();
  if (base === '') return { received: false };
  try {
    const url = new URL('stripe/webhook', base.endsWith('/') ? base : `${base}/`);
    const body = new Uint8Array(rawBody);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signatureHeader,
      },
      body,
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 400) throw new Error(`POST stripe/webhook -> ${res.status}`);
    const data = (await res.json()) as { received?: unknown };
    return { received: data.received === true };
  } catch (err) {
    logFailure(err);
    return { received: false };
  }
}

/** GET balance/:accountId. Balance null when the service is off. */
export async function claudiumBalance(accountId: number): Promise<ClaudiumBalanceResult> {
  const data = await callService<{ balance: number }>({
    method: 'GET',
    path: `balance/${encodeURIComponent(String(accountId))}`,
  });
  const available = typeof data?.balance === 'number';
  return { available, balance: typeof data?.balance === 'number' ? data.balance : null };
}

/** GET price/:rail. Prices null when the service is off (buy disabled). */
export async function claudiumPrice(rail: ClaudiumPriceRail): Promise<ClaudiumPriceResult> {
  const data = await callService<{
    rail: string;
    usdPerClaudium: number;
  }>({ method: 'GET', path: `price/${encodeURIComponent(rail)}` });
  if (!data) return { rail, usdPerClaudium: null };
  return {
    rail: data.rail,
    usdPerClaudium: typeof data.usdPerClaudium === 'number' ? data.usdPerClaudium : null,
  };
}

/** GET skus. Empty ladder when the service is off (stripe rail disabled). */
export async function claudiumSkus(): Promise<ClaudiumSkusResult> {
  const data = await callService<ClaudiumSku[]>({ method: 'GET', path: 'skus' });
  if (!Array.isArray(data)) return { available: false, skus: [] };
  const skus = data
    .filter(
      (s): s is ClaudiumSku =>
        typeof s?.sku === 'string' && typeof s.usd === 'number' && typeof s.claudium === 'number',
    )
    .map((s) => ({
      sku: s.sku,
      usd: s.usd,
      claudium: s.claudium,
      stripeConfigured:
        typeof (s as { stripeConfigured?: unknown }).stripeConfigured === 'boolean'
          ? (s as { stripeConfigured: boolean }).stripeConfigured
          : undefined,
    }));
  return { available: true, skus };
}

/** POST purchase. Returns ok:false with a reason when the service is off. */
export async function claudiumPurchase(input: {
  accountId: number;
  rail: 'stripe';
  sku: string;
  idempotencyKey: string;
}): Promise<ClaudiumPurchaseResult> {
  const data = await callService<{
    purchaseId?: string;
    rail?: ClaudiumRail;
    claudium?: number;
    stripe?: ClaudiumStripeIntent;
    reason?: string;
  }>({ method: 'POST', path: 'purchase', body: input });
  if (!data) {
    return {
      ok: false,
      purchaseId: null,
      rail: null,
      claudium: null,
      stripe: null,
      reason: 'unavailable',
    };
  }
  const reason = typeof data.reason === 'string' ? data.reason : null;
  const purchaseId =
    typeof data.purchaseId === 'string' && data.purchaseId !== '' ? data.purchaseId : null;
  const rail = data.rail === 'stripe' ? data.rail : null;
  const claudium =
    typeof data.claudium === 'number' && Number.isInteger(data.claudium) && data.claudium > 0
      ? data.claudium
      : null;
  const stripe =
    typeof data.stripe?.clientSecret === 'string' &&
    data.stripe.clientSecret.trim() !== '' &&
    typeof data.stripe.publishableKey === 'string' &&
    data.stripe.publishableKey.trim() !== ''
      ? {
          clientSecret: data.stripe.clientSecret,
          publishableKey: data.stripe.publishableKey,
        }
      : null;
  const ok =
    reason === null &&
    purchaseId !== null &&
    rail === input.rail &&
    claudium !== null &&
    stripe !== null;
  if (!ok) {
    return {
      ok: false,
      purchaseId: null,
      rail: null,
      claudium: null,
      stripe: null,
      reason: reason ?? 'unavailable',
    };
  }
  return {
    ok: true,
    purchaseId,
    rail,
    claudium,
    stripe,
    reason: null,
  };
}

/** POST spend. granted:false when the service is off. */
export async function claudiumSpend(input: {
  accountId: number;
  itemId: string;
  kind: 'cosmetic' | 'skin' | 'item';
  expectedCostClaudium: number;
  idempotencyKey: string;
}): Promise<ClaudiumSpendResult> {
  const data = await callService<{
    granted: boolean;
    balance: number;
    costClaudium?: number;
    reason?: string;
  }>({ method: 'POST', path: 'spend', body: input });
  if (!data) return { granted: false, balance: null, costClaudium: null, reason: 'unavailable' };
  return {
    granted: Boolean(data.granted),
    balance: typeof data.balance === 'number' ? data.balance : null,
    costClaudium: typeof data.costClaudium === 'number' ? data.costClaudium : null,
    reason: data.reason ?? null,
  };
}

/** GET history/:accountId. Empty when the service is off. */
export async function claudiumHistory(accountId: number): Promise<ClaudiumHistoryResult> {
  const data = await callService<ClaudiumHistoryEntry[]>({
    method: 'GET',
    path: `history/${encodeURIComponent(String(accountId))}`,
  });
  if (!Array.isArray(data)) return { entries: [] };
  const entries = data.filter(
    (entry): entry is ClaudiumHistoryEntry =>
      typeof entry?.entryId === 'string' &&
      entry.accountId === accountId &&
      typeof entry.delta === 'number' &&
      typeof entry.reason === 'string' &&
      typeof entry.ref === 'string' &&
      typeof entry.atMs === 'number',
  );
  return { entries };
}

/** GET store. The cosmetic catalog, priced in Claudium by the service. Empty when off. */
export async function claudiumStore(accountId: number): Promise<ClaudiumStoreResult> {
  const data = await callService<ClaudiumStoreItem[]>({
    method: 'GET',
    path: `store/${encodeURIComponent(String(accountId))}`,
  });
  if (!Array.isArray(data)) return { available: false, items: [] };
  const items = data.filter(
    (i): i is ClaudiumStoreItem =>
      typeof i?.itemId === 'string' &&
      typeof i.name === 'string' &&
      typeof i.costClaudium === 'number' &&
      typeof i.owned === 'boolean' &&
      (i.kind === 'cosmetic' || i.kind === 'skin' || i.kind === 'item'),
  );
  return { available: true, items };
}
