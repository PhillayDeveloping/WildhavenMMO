import { describe, expect, it } from 'vitest';
import { buildClaudiumView, type ClaudiumViewInput } from '../src/ui/claudium_view';

// The pure Claudium view core is DOM/i18n/net-free, so it drives directly here.
// Two states matter: a funded state (service on) and the service-off disabled
// state (balance null). The core recomputes NOTHING; it only projects the
// service payloads into render rows + rail availability.

const funded: ClaudiumViewInput = {
  balance: 1250,
  skus: [
    { sku: 's1', usd: 1, claudium: 100 },
    { sku: 's10', usd: 10, claudium: 1000 },
    { sku: 's100', usd: 100, claudium: 10000 },
  ],
};

describe('buildClaudiumView disabled state (service off)', () => {
  it('renders a clean empty state when balance is null, not an error', () => {
    const view = buildClaudiumView({
      balance: null,
      skus: [],
    });
    expect(view.disabled).toBe(true);
    expect(view.hasBalance).toBe(false);
    expect(view.balance).toBeNull();
    expect(view.buyRows).toEqual([]);
    expect(view.rails).toEqual({ stripe: false });
    expect(view.buyDisabled).toBe(true);
  });

  it('stays disabled even if skus somehow arrive with a null balance', () => {
    // A null balance is authoritative: the service is off, so nothing transacts.
    const view = buildClaudiumView({
      balance: null,
      skus: [{ sku: 's1', usd: 1, claudium: 100 }],
    });
    expect(view.disabled).toBe(true);
    expect(view.buyRows).toEqual([]);
    expect(view.buyDisabled).toBe(true);
  });
});

describe('buildClaudiumView funded state (service on)', () => {
  it('maps the SKU ladder verbatim into buy rows', () => {
    const view = buildClaudiumView(funded);
    expect(view.disabled).toBe(false);
    expect(view.hasBalance).toBe(true);
    expect(view.balance).toBe(1250);
    expect(view.buyRows).toEqual([
      { sku: 's1', usd: 1, claudium: 100, stripeConfigured: true },
      { sku: 's10', usd: 10, claudium: 1000, stripeConfigured: true },
      { sku: 's100', usd: 100, claudium: 10000, stripeConfigured: true },
    ]);
  });

  it('enables the card rail when the service exposes a configured SKU ladder', () => {
    const view = buildClaudiumView(funded);
    expect(view.rails).toEqual({ stripe: true });
    expect(view.buyDisabled).toBe(false);
  });

  it('keeps unconfigured Stripe SKU rows visible but disables the rail', () => {
    // Every rung unconfigured means nothing can transact, so the rail goes down
    // while the rows stay visible: the player sees the ladder and why it is dead.
    const view = buildClaudiumView({
      ...funded,
      skus: [
        { sku: 's1', usd: 1, claudium: 100, stripeConfigured: false },
        { sku: 's10', usd: 10, claudium: 1000, stripeConfigured: false },
      ],
    });
    expect(view.buyRows).toEqual([
      { sku: 's1', usd: 1, claudium: 100, stripeConfigured: false },
      { sku: 's10', usd: 10, claudium: 1000, stripeConfigured: false },
    ]);
    expect(view.rails).toEqual({ stripe: false });
    expect(view.buyDisabled).toBe(true);
  });

  it('keeps the rail up when only SOME rungs are unconfigured', () => {
    const view = buildClaudiumView({
      ...funded,
      skus: [
        { sku: 's1', usd: 1, claudium: 100, stripeConfigured: false },
        { sku: 's10', usd: 10, claudium: 1000, stripeConfigured: true },
      ],
    });
    expect(view.rails).toEqual({ stripe: true });
    expect(view.buyDisabled).toBe(false);
  });

  it('disables the rail when there are no skus', () => {
    const view = buildClaudiumView({ ...funded, skus: [] });
    expect(view.rails).toEqual({ stripe: false });
    expect(view.buyDisabled).toBe(true);
  });

  it('treats a zero balance as a known funded state, not the disabled state', () => {
    const view = buildClaudiumView({ ...funded, balance: 0 });
    expect(view.disabled).toBe(false);
    expect(view.hasBalance).toBe(true);
    expect(view.balance).toBe(0);
  });
});

describe('buildClaudiumView is a pure projection', () => {
  it('returns identical structure for identical input (no hidden state)', () => {
    expect(buildClaudiumView(funded)).toEqual(buildClaudiumView(funded));
  });
});
