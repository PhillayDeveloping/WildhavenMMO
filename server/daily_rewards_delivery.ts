// Daily standings prize delivery: the seam between the finalized payout rows and
// the winner's mailbox.
//
// The daily board finalizes on a schedule (at the day rollover), so the ten
// players who placed are normally offline at the moment their shares are decided
// and there is nobody to hand the coin to. Upstream solved that with an external
// payment runner draining a queue; here the coin is in-game, so the queue is just
// the payout rows and the delivery is a Ravenpost letter posted the next time the
// winner logs in.
//
// The decision half (planPrizeDeliveries) is pure and unit tested; the IO half
// (deliverOwedPrizes) is a thin shell over an injected deps bag, so it tests with
// no database and no sim.

import type { DailyRewardOwedPrize } from './daily_rewards_db';

/** One letter the sweep is about to post, already ordered and validated. */
export interface PrizeDelivery {
  day: string;
  rank: number;
  copper: number;
}

/**
 * Decide which letters a set of owed rows becomes.
 *
 * One letter per placing, oldest day first, so a player returning after a week
 * away reads their mailbox in the order the days happened. Rows are dropped
 * rather than rounded when the amount is not a positive whole number of copper:
 * the claim query already filters `prize_copper > 0`, so anything else here is a
 * corrupt row, and posting a letter with no coin in it (or crediting a
 * fraction) would be worse than skipping it.
 */
export function planPrizeDeliveries(owed: readonly DailyRewardOwedPrize[]): PrizeDelivery[] {
  return owed
    .filter((row) => Number.isFinite(row.prizeCopper) && Math.floor(row.prizeCopper) > 0)
    .map((row) => ({ day: row.day, rank: row.rank, copper: Math.floor(row.prizeCopper) }))
    .sort((left, right) =>
      left.day === right.day ? left.rank - right.rank : left.day < right.day ? -1 : 1,
    );
}

export interface PrizeDeliveryDeps {
  /** Claims every owed row for the account and marks it paid in one statement. */
  claimOwedPrizes: (accountId: number) => Promise<DailyRewardOwedPrize[]>;
  /** Posts one prize letter into the live player's mailbox. */
  mailPrize: (pid: number, copper: number) => void;
  /** Diagnostic sink; delivery failures must never reach the player. */
  onError: (err: unknown) => void;
}

/**
 * Claim and post every prize this account is owed. Returns what was delivered
 * (the empty array is the overwhelmingly common case: only ten accounts a day
 * are owed anything at all).
 *
 * Called fire-and-forget from the join path: a database hiccup here must never
 * fail a handshake or kick a player, so every failure is swallowed into onError.
 * The cost of a swallowed failure is bounded and self-healing, because a row the
 * claim never marked paid stays 'pending' and is simply delivered at the next
 * join.
 *
 * The exposure runs the other way, and is the deliberate price of never paying
 * twice: the claim marks the rows paid BEFORE the letters are booked, so coin is
 * lost if the session stops existing in between. Two ways that can happen, both
 * narrow:
 *   - the process dies mid-await. One realm restart, at most ten accounts.
 *   - `pid` stops resolving in the sim before mailPrize runs, which the sim
 *     treats as a silent no-op. A dropped socket does NOT do this (the session
 *     is held in-world for the linkdead grace), so it takes a hard teardown
 *     (moderation kick, takeover) landing inside the claim query itself.
 * Posting first and marking after would trade both for double payment on a
 * retry, which is worse: a duplicated purse is unrecoverable economy damage,
 * while a missed one is a support fix.
 */
export async function deliverOwedPrizes(
  deps: PrizeDeliveryDeps,
  accountId: number,
  pid: number,
): Promise<PrizeDelivery[]> {
  try {
    const owed = await deps.claimOwedPrizes(accountId);
    if (owed.length === 0) return [];
    const deliveries = planPrizeDeliveries(owed);
    for (const delivery of deliveries) deps.mailPrize(pid, delivery.copper);
    return deliveries;
  } catch (err) {
    deps.onError(err);
    return [];
  }
}
