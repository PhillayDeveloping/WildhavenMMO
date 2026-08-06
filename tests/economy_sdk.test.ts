import { afterEach, describe, expect, it, vi } from 'vitest';
import { EconomyClient, startClaudiumPurchase } from '../src/net/economy_sdk';
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EconomyClient store snapshot', () => {
  it('marks the snapshot available only when balance and catalog both load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/api/claudium/balance')) {
          return new Response(JSON.stringify({ balance: 750 }), { status: 200 });
        }
        if (url.endsWith('/api/claudium/store')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  itemId: 'ice_fang_sword',
                  name: 'Ice Fang',
                  kind: 'skin',
                  costClaudium: 3000,
                  owned: false,
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 404 });
      }),
    );

    const snapshot = await new EconomyClient({
      token: () => 'token',
      base: 'https://game.example',
    }).storeSnapshot();

    expect(snapshot).toEqual({
      available: true,
      balance: 750,
      items: [
        {
          itemId: 'ice_fang_sword',
          name: 'Ice Fang',
          kind: 'skin',
          costClaudium: 3000,
          owned: false,
        },
      ],
    });
  });

  it('marks a partial refresh unavailable instead of presenting fallback rows as fresh data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/api/claudium/balance')) {
          return new Response(JSON.stringify({ balance: 250 }), { status: 200 });
        }
        return new Response(null, { status: 503 });
      }),
    );

    const snapshot = await new EconomyClient({
      token: () => 'token',
      base: 'https://game.example',
    }).storeSnapshot();

    expect(snapshot).toEqual({ available: false, balance: 250, items: [] });
  });

  it('preserves the upstream unavailable marker returned through the game proxy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/api/claudium/balance')) {
          return new Response(JSON.stringify({ balance: 250 }), { status: 200 });
        }
        if (url.endsWith('/api/claudium/store')) {
          return new Response(JSON.stringify({ available: false, items: [] }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }),
    );

    const snapshot = await new EconomyClient({
      token: () => 'token',
      base: 'https://game.example',
    }).storeSnapshot();

    expect(snapshot).toEqual({ available: false, balance: 250, items: [] });
  });
});

describe('EconomyClient pack snapshot', () => {
  it('marks the snapshot available when balance and packs both load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/api/claudium/balance')) {
          return new Response(JSON.stringify({ available: true, balance: 250 }), { status: 200 });
        }
        if (url.endsWith('/api/claudium/skus')) {
          return new Response(
            JSON.stringify({
              available: true,
              skus: [{ sku: 'claudium_500', usd: 4.99, claudium: 500 }],
            }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 404 });
      }),
    );

    const snapshot = await new EconomyClient({
      token: () => 'token',
      base: 'https://game.example',
    }).packSnapshot();

    expect(snapshot).toEqual({
      available: true,
      balance: 250,
      skus: [{ sku: 'claudium_500', usd: 4.99, claudium: 500 }],
    });
  });

  it('marks a partial pack refresh unavailable instead of presenting fallbacks as fresh data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/api/claudium/balance')) {
          return new Response(JSON.stringify({ available: true, balance: 250 }), { status: 200 });
        }
        if (url.endsWith('/api/claudium/skus')) {
          return new Response(
            JSON.stringify({
              available: false,
              skus: [{ sku: 'claudium_500', usd: 4.99, claudium: 500 }],
            }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 404 });
      }),
    );

    const snapshot = await new EconomyClient({
      token: () => 'token',
      base: 'https://game.example',
    }).packSnapshot();

    expect(snapshot).toEqual({
      available: false,
      balance: 250,
      skus: [{ sku: 'claudium_500', usd: 4.99, claudium: 500 }],
    });
  });
});

describe('startClaudiumPurchase', () => {
  it('captures the server intent and hands it to the card signer', async () => {
    const client = new EconomyClient({ token: () => 'token', base: 'https://game.example' });
    const purchase = vi.spyOn(client, 'purchase').mockResolvedValue({
      ok: true,
      purchaseId: 'pi_1',
      rail: 'stripe',
      claudium: 500,
      stripe: { clientSecret: 'cs_test', publishableKey: 'pk_test' },
      reason: null,
    });
    const stripe = vi.fn(async () => {});

    const result = await startClaudiumPurchase(client, 'stripe', 'claudium_500', { stripe });

    expect(purchase).toHaveBeenCalledWith(
      expect.objectContaining({ rail: 'stripe', sku: 'claudium_500' }),
    );
    expect(stripe).toHaveBeenCalledWith({ clientSecret: 'cs_test', publishableKey: 'pk_test' }, 'pi_1');
    expect(result.ok).toBe(true);
  });

  it('stops after the server intent when no card signer is wired, charging nothing', async () => {
    // The signer seam is optional on purpose: without Stripe.js the flow captures
    // the intent and stops rather than throwing into render.
    const client = new EconomyClient({ token: () => 'token', base: 'https://game.example' });
    vi.spyOn(client, 'purchase').mockResolvedValue({
      ok: true,
      purchaseId: 'pi_2',
      rail: 'stripe',
      claudium: 500,
      stripe: { clientSecret: 'cs_test', publishableKey: 'pk_test' },
      reason: null,
    });

    const result = await startClaudiumPurchase(client, 'stripe', 'claudium_500');

    expect(result.ok).toBe(true);
    expect(result.purchaseId).toBe('pi_2');
  });

  it('returns the refusal untouched when the service declines the purchase', async () => {
    const client = new EconomyClient({ token: () => 'token', base: 'https://game.example' });
    vi.spyOn(client, 'purchase').mockResolvedValue({
      ok: false,
      purchaseId: null,
      rail: null,
      claudium: null,
      stripe: null,
      reason: 'unavailable',
    });
    const stripe = vi.fn(async () => {});

    const result = await startClaudiumPurchase(client, 'stripe', 'claudium_500', { stripe });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unavailable');
    expect(stripe).not.toHaveBeenCalled();
  });
});
