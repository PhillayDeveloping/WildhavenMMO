// Pure, host-agnostic view model for the CLAUDIUM window.
//
// The pure-core half of the pure-core + thin-consumer split (root CLAUDE.md
// Conventions; reference vendor_view.ts / stat_tooltip_view.ts). CLAUDIUM is a
// server-authoritative soft currency: the peg, prices, SKU credits, balance, and
// purchase amounts ALL come from the economy service. This core recomputes NONE of
// them; it only projects the service payloads into the render rows and the
// per-rail availability the window paints. DOM-free and i18n-free so
// tests/claudium_view.test.ts can drive it directly.
//
// The one non-negotiable: when the balance is null (the service is off) the model
// is a clean disabled/empty state, NEVER an error crash.

/** A price rung as returned by the service (usd + Claudium credited). */
export interface ClaudiumSkuInput {
  sku: string;
  usd: number;
  claudium: number;
  /** False when the Stripe price env var for this SKU is not configured. */
  stripeConfigured?: boolean;
}

/** The raw inputs, all sourced from the service via the SDK. */
export interface ClaudiumViewInput {
  /** Integer Claudium balance, or null when the service is off. */
  balance: number | null;
  skus: readonly ClaudiumSkuInput[];
}

/** One buy-picker row: the money label and the Claudium credited, both from the service. */
export interface ClaudiumBuyRow {
  sku: string;
  usd: number;
  claudium: number;
  stripeConfigured: boolean;
}

/** Which purchase rails the window may enable. Card payment is the only rail. */
export interface ClaudiumRailAvailability {
  /** Stripe is available when there is at least one SKU rung to buy. */
  stripe: boolean;
}

export interface ClaudiumView {
  /** True when the service is off (balance null): render the disabled/empty state. */
  disabled: boolean;
  /** Whether a numeric balance is known (false in the disabled state). */
  hasBalance: boolean;
  /** The integer balance to render, or null in the disabled state. */
  balance: number | null;
  buyRows: ClaudiumBuyRow[];
  rails: ClaudiumRailAvailability;
  /** True when the rail cannot transact (nothing configured to buy). */
  buyDisabled: boolean;
}

/**
 * Project the service payloads into the render model.
 *
 * Disabled state: a null balance means the service is off, so every buy row
 * is dropped and the rail is unavailable, a clean empty state (not an error).
 * Funded state: buy rows mirror the SKU ladder verbatim, and card is available
 * when its configured SKU ladder is non-empty.
 */
export function buildClaudiumView(input: ClaudiumViewInput): ClaudiumView {
  if (input.balance === null) {
    return {
      disabled: true,
      hasBalance: false,
      balance: null,
      buyRows: [],
      rails: { stripe: false },
      buyDisabled: true,
    };
  }

  const buyRows: ClaudiumBuyRow[] = input.skus.map((s) => ({
    sku: s.sku,
    usd: s.usd,
    claudium: s.claudium,
    stripeConfigured: s.stripeConfigured !== false,
  }));
  const stripe = buyRows.some((row) => row.stripeConfigured);
  return {
    disabled: false,
    hasBalance: true,
    balance: input.balance,
    buyRows,
    rails: { stripe },
    buyDisabled: !stripe,
  };
}
