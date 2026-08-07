import { describe, expect, it, vi } from 'vitest';
import type { DailyRewardOwedPrize } from '../server/daily_rewards_db';
import {
  deliverOwedPrizes,
  type PrizeDeliveryDeps,
  planPrizeDeliveries,
} from '../server/daily_rewards_delivery';

// The daily standings prize seam: which letters a set of owed rows becomes
// (pure), and the claim-then-post shell that runs at join. Neither half needs a
// database or a Sim, which is the point of the split.

const owed = (day: string, rank: number, prizeCopper: number): DailyRewardOwedPrize => ({
  day,
  rank,
  prizeCopper,
});

describe('planPrizeDeliveries', () => {
  it('posts one letter per placing, oldest day first', () => {
    // A player away for several days reads their mailbox in the order the days
    // happened, not in whatever order the UPDATE returned rows.
    expect(
      planPrizeDeliveries([
        owed('2026-07-03', 2, 375_000),
        owed('2026-07-01', 1, 500_000),
        owed('2026-07-02', 5, 90_000),
      ]),
    ).toEqual([
      { day: '2026-07-01', rank: 1, copper: 500_000 },
      { day: '2026-07-02', rank: 5, copper: 90_000 },
      { day: '2026-07-03', rank: 2, copper: 375_000 },
    ]);
  });

  it('breaks a same-day tie by rank, so two placings on one day still read in order', () => {
    expect(
      planPrizeDeliveries([owed('2026-07-01', 3, 120_000), owed('2026-07-01', 1, 500_000)]),
    ).toEqual([
      { day: '2026-07-01', rank: 1, copper: 500_000 },
      { day: '2026-07-01', rank: 3, copper: 120_000 },
    ]);
  });

  it('drops a row that would post an empty or fractional letter', () => {
    // The claim query already filters prize_copper > 0, so anything here is a
    // corrupt row. Posting a coinless letter, or crediting a fraction of a
    // copper, is worse than skipping it.
    expect(
      planPrizeDeliveries([
        owed('2026-07-01', 1, 0),
        owed('2026-07-02', 1, -500),
        owed('2026-07-03', 1, Number.NaN),
        owed('2026-07-04', 1, Number.POSITIVE_INFINITY),
        owed('2026-07-05', 1, 0.5),
      ]),
    ).toEqual([]);
  });

  it('floors a fractional amount rather than rounding it up', () => {
    // Rounding up mints coin from nothing, once per placing per day.
    expect(planPrizeDeliveries([owed('2026-07-01', 1, 1234.99)])).toEqual([
      { day: '2026-07-01', rank: 1, copper: 1234 },
    ]);
  });

  it('returns an empty plan for no owed rows, the overwhelmingly common case', () => {
    expect(planPrizeDeliveries([])).toEqual([]);
  });
});

describe('deliverOwedPrizes', () => {
  function deps(overrides: Partial<PrizeDeliveryDeps> = {}): {
    deps: PrizeDeliveryDeps;
    mailed: { pid: number; copper: number }[];
    errors: unknown[];
  } {
    const mailed: { pid: number; copper: number }[] = [];
    const errors: unknown[] = [];
    return {
      mailed,
      errors,
      deps: {
        claimOwedPrizes: async () => [],
        mailPrize: (pid, copper) => mailed.push({ pid, copper }),
        onError: (err) => errors.push(err),
        ...overrides,
      },
    };
  }

  it('posts a letter to the joining player for every claimed prize', async () => {
    const h = deps({
      claimOwedPrizes: async () => [owed('2026-07-01', 1, 500_000), owed('2026-07-02', 4, 100_000)],
    });

    const delivered = await deliverOwedPrizes(h.deps, 42, 7);

    expect(delivered).toHaveLength(2);
    expect(h.mailed).toEqual([
      { pid: 7, copper: 500_000 },
      { pid: 7, copper: 100_000 },
    ]);
    expect(h.errors).toEqual([]);
  });

  it('claims for the ACCOUNT and mails to the PID, which are different id spaces', async () => {
    // Swapping these silently pays the wrong player: account ids and sim entity
    // ids are both small integers, so nothing else would catch it.
    const claim = vi.fn(async () => [owed('2026-07-01', 1, 500_000)]);
    const h = deps({ claimOwedPrizes: claim });

    await deliverOwedPrizes(h.deps, 42, 7);

    expect(claim).toHaveBeenCalledWith(42);
    expect(h.mailed).toEqual([{ pid: 7, copper: 500_000 }]);
  });

  it('mails nothing and reads nothing further when the account is owed nothing', async () => {
    const h = deps({ claimOwedPrizes: async () => [] });

    expect(await deliverOwedPrizes(h.deps, 42, 7)).toEqual([]);
    expect(h.mailed).toEqual([]);
  });

  it('swallows a database failure instead of letting it reach the handshake', async () => {
    // This runs on the join path. A failing read must never refuse a login; the
    // rows stay pending and are delivered at the next join.
    const boom = new Error('pool exhausted');
    const h = deps({
      claimOwedPrizes: async () => {
        throw boom;
      },
    });

    expect(await deliverOwedPrizes(h.deps, 42, 7)).toEqual([]);
    expect(h.mailed).toEqual([]);
    expect(h.errors).toEqual([boom]);
  });

  it('swallows a mail failure the same way, after the claim already landed', async () => {
    const boom = new Error('mailbox exploded');
    const h = deps({
      claimOwedPrizes: async () => [owed('2026-07-01', 1, 500_000)],
      mailPrize: () => {
        throw boom;
      },
    });

    expect(await deliverOwedPrizes(h.deps, 42, 7)).toEqual([]);
    expect(h.errors).toEqual([boom]);
  });

  it('never resolves rejected, so the fire-and-forget call site cannot go unhandled', async () => {
    const h = deps({
      claimOwedPrizes: async () => {
        throw new Error('any failure at all');
      },
    });

    // The join path calls this with `void`, so a rejection here would surface as
    // an unhandled rejection and, under Node's default, take the realm down.
    await expect(deliverOwedPrizes(h.deps, 42, 7)).resolves.toBeDefined();
  });
});
