// Client-side typed fetch wrapper for the CLAUDIUM economy surface.
//
// Same-origin only: it talks to the GAME server's /api/claudium/* routes (never
// the economy service directly). Those routes proxy to the service and already
// fail closed, so this layer only has to survive a network hiccup or a logged-out
// caller. It NEVER throws into render: every failure resolves to the same typed
// unavailable state the disabled UI renders (balance null, empty skus/store, buy
// disabled). The client computes NO peg/price/balance; it renders what it gets.

import { apiUrl } from './online';

export type ClaudiumRail = 'stripe';
export type ClaudiumPriceRail = 'stripe';

export interface ClaudiumBalance {
  available?: boolean;
  balance: number | null;
}

export interface ClaudiumPrice {
  rail: string;
  usdPerClaudium: number | null;
}

export interface ClaudiumSku {
  sku: string;
  usd: number;
  claudium: number;
  stripeConfigured?: boolean;
}

export interface ClaudiumStoreItem {
  itemId: string;
  name: string;
  kind: 'cosmetic' | 'skin' | 'item';
  costClaudium: number;
  owned: boolean;
}

export interface ClaudiumStoreSnapshot {
  available: boolean;
  balance: number | null;
  items: ClaudiumStoreItem[];
}

export interface ClaudiumPackSnapshot {
  available: boolean;
  balance: number | null;
  skus: ClaudiumSku[];
}

export interface ClaudiumStripeIntent {
  clientSecret: string;
  publishableKey: string;
}

export interface ClaudiumPurchase {
  ok: boolean;
  purchaseId: string | null;
  rail: ClaudiumRail | null;
  claudium: number | null;
  stripe: ClaudiumStripeIntent | null;
  reason: string | null;
}

export interface ClaudiumSpend {
  granted: boolean;
  balance: number | null;
  costClaudium: number | null;
  reason: string | null;
}

/** How the SDK reaches the authed game-server routes: a live token + realm base. */
export interface EconomyClientConfig {
  token(): string | null | undefined;
  base?: string;
}

const OFF_BALANCE: ClaudiumBalance = { available: false, balance: null };
const OFF_PRICE = (rail: string): ClaudiumPrice => ({
  rail,
  usdPerClaudium: null,
});
const OFF_SKUS: ClaudiumSku[] = [];
const OFF_STORE: ClaudiumStoreItem[] = [];
const OFF_PURCHASE: ClaudiumPurchase = {
  ok: false,
  purchaseId: null,
  rail: null,
  claudium: null,
  stripe: null,
  reason: 'unavailable',
};
const OFF_SPEND: ClaudiumSpend = {
  granted: false,
  balance: null,
  costClaudium: null,
  reason: 'unavailable',
};

export class EconomyClient {
  constructor(private readonly cfg: EconomyClientConfig) {}

  private async getResult<T>(path: string, fallback: T): Promise<{ ok: boolean; value: T }> {
    const token = this.cfg.token();
    if (!token) return { ok: false, value: fallback };
    try {
      const res = await fetch(apiUrl(path, this.cfg.base ?? ''), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, value: fallback };
      return { ok: true, value: (await res.json()) as T };
    } catch {
      return { ok: false, value: fallback };
    }
  }

  private async get<T>(path: string, fallback: T): Promise<T> {
    return (await this.getResult(path, fallback)).value;
  }

  private async post<T>(path: string, body: unknown, fallback: T): Promise<T> {
    const token = this.cfg.token();
    if (!token) return fallback;
    try {
      const res = await fetch(apiUrl(path, this.cfg.base ?? ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) return fallback;
      return (await res.json()) as T;
    } catch {
      return fallback;
    }
  }

  balance(): Promise<ClaudiumBalance> {
    return this.get('/api/claudium/balance', OFF_BALANCE);
  }

  price(rail: ClaudiumPriceRail): Promise<ClaudiumPrice> {
    return this.get(`/api/claudium/price/${rail}`, OFF_PRICE(rail));
  }

  skus(): Promise<ClaudiumSku[]> {
    return this.get('/api/claudium/skus', { skus: OFF_SKUS }).then((r) => r.skus ?? OFF_SKUS);
  }

  store(): Promise<ClaudiumStoreItem[]> {
    return this.get('/api/claudium/store', { items: OFF_STORE }).then((r) => r.items ?? OFF_STORE);
  }

  async storeSnapshot(): Promise<ClaudiumStoreSnapshot> {
    const [balance, store] = await Promise.all([
      this.getResult('/api/claudium/balance', OFF_BALANCE),
      this.getResult<{ available?: boolean; items: ClaudiumStoreItem[] }>('/api/claudium/store', {
        available: false,
        items: OFF_STORE,
      }),
    ]);
    return {
      available:
        balance.ok &&
        balance.value.available !== false &&
        store.ok &&
        store.value.available !== false,
      balance: balance.value.balance,
      items: store.value.items ?? OFF_STORE,
    };
  }

  async packSnapshot(): Promise<ClaudiumPackSnapshot> {
    const [balance, skus] = await Promise.all([
      this.getResult('/api/claudium/balance', OFF_BALANCE),
      this.getResult<{ available?: boolean; skus: ClaudiumSku[] }>('/api/claudium/skus', {
        available: false,
        skus: OFF_SKUS,
      }),
    ]);
    return {
      available:
        balance.ok && balance.value.available === true && skus.ok && skus.value.available === true,
      balance: balance.value.balance,
      skus: skus.value.skus ?? OFF_SKUS,
    };
  }

  purchase(input: {
    rail: 'stripe';
    sku: string;
    idempotencyKey: string;
  }): Promise<ClaudiumPurchase> {
    return this.post('/api/claudium/purchase', input, OFF_PURCHASE);
  }

  spend(input: {
    itemId: string;
    kind: 'cosmetic' | 'skin' | 'item';
    expectedCostClaudium: number;
    idempotencyKey: string;
  }): Promise<ClaudiumSpend> {
    return this.post('/api/claudium/spend', input, OFF_SPEND);
  }
}

/** A fresh idempotency key for a purchase/spend attempt (crypto-random, safe to retry). */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Optional client-side signer for the card rail. main.ts passes this once the
 * live integration exists; until then it is absent and the flow stops cleanly
 * after the server intent (no crash, nothing charged).
 *
 * - stripe: hand the returned clientSecret + publishableKey to Stripe.js and
 *   confirm the PaymentIntent client-side. Needs a live publishable key + Stripe.js.
 */
export interface ClaudiumSigners {
  stripe?(intent: ClaudiumStripeIntent, purchaseId: string): Promise<void>;
}

/**
 * Orchestrate one purchase end to end: ask the server for the rail-specific intent,
 * then drive the client-side signing seam. This computes NOTHING about price or
 * credit; it only sequences the SDK calls. If the service is off (ok:false) or the
 * needed signer is not wired, it returns without charging anything.
 */
export async function startClaudiumPurchase(
  client: EconomyClient,
  rail: ClaudiumRail,
  sku: string,
  signers: ClaudiumSigners = {},
): Promise<ClaudiumPurchase> {
  const purchase = await client.purchase({ rail, sku, idempotencyKey: newIdempotencyKey() });
  if (!purchase.ok || !purchase.purchaseId) return purchase;
  // SEAM: the stripe confirmation needs Stripe.js + a live publishable key. When
  // a signer is wired, it confirms the PaymentIntent with the returned
  // clientSecret; otherwise the flow stops here with the server intent captured.
  if (purchase.stripe && signers.stripe) {
    await signers.stripe(purchase.stripe, purchase.purchaseId);
  }
  return purchase;
}
