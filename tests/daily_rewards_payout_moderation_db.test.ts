import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    row: null as Record<string, unknown> | null,
    audit: [] as Array<{ sql: string; params: unknown[] }>,
    attempts: [] as Array<{
      kind: 'payout' | 'resend';
      status: 'prepared' | 'paid' | 'failed';
      operationId: unknown;
      signature: unknown;
      transaction: unknown;
    }>,
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const statement = String(sql);
    if (statement.includes('FOR UPDATE OF p')) {
      return { rows: state.row ? [{ ...state.row }] : [], rowCount: state.row ? 1 : 0 };
    }
    if (statement.includes('SELECT status') && statement.includes('FOR UPDATE')) {
      return state.row
        ? { rows: [{ status: state.row.status }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (
      statement.includes('SELECT status, operation_id, tx_signature, signed_transaction') &&
      statement.includes("kind = 'resend'")
    ) {
      const attempt = [...state.attempts]
        .reverse()
        .find((item) => item.kind === 'resend' && item.operationId === params[3]);
      return attempt
        ? {
            rows: [
              {
                status: attempt.status,
                operation_id: attempt.operationId,
                tx_signature: attempt.signature,
                signed_transaction: attempt.transaction,
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (statement.includes('SELECT 1') && statement.includes('FROM daily_reward_payout_attempts')) {
      const matches = state.attempts.some(
        (item) =>
          item.kind === 'resend' &&
          item.status === 'paid' &&
          item.operationId === params[3] &&
          item.signature === params[4],
      );
      return { rows: matches ? [{ '?column?': 1 }] : [], rowCount: matches ? 1 : 0 };
    }
    if (statement.includes('SELECT 1') && statement.includes("status = 'paid'")) {
      const matches = state.row?.status === 'paid' && state.row.tx_signature === params[3];
      return { rows: matches ? [{ '?column?': 1 }] : [], rowCount: matches ? 1 : 0 };
    }
    if (statement.includes("SET status = 'voided'")) {
      if (!state.row || !['pending', 'failed'].includes(String(state.row.status))) {
        return { rows: [], rowCount: 0 };
      }
      state.row = {
        ...state.row,
        status: 'voided',
        void_reason: params[3],
        voided_by_id: params[4],
        voided_by_username: params[5],
        voided_at: new Date('2026-07-15T01:02:03.000Z'),
      };
      return { rows: [{ ...state.row }], rowCount: 1 };
    }
    if (statement.includes("SET status = 'pending'")) {
      if (state.row?.status !== 'voided') return { rows: [], rowCount: 0 };
      state.row = {
        ...state.row,
        status: 'pending',
        void_reason: null,
        voided_by_id: null,
        voided_by_username: null,
        voided_at: null,
      };
      return { rows: [{ ...state.row }], rowCount: 1 };
    }
    if (statement.includes('INSERT INTO daily_reward_payout_attempts')) {
      const resend = statement.includes("'resend'");
      state.attempts.push({
        kind: resend ? 'resend' : 'payout',
        status: 'prepared',
        operationId: resend ? params[3] : null,
        signature: params[resend ? 4 : 3],
        transaction: params[resend ? 5 : 4],
      });
      return { rows: [], rowCount: 1 };
    }
    if (
      statement.includes('UPDATE daily_reward_payout_attempts') &&
      statement.includes("kind = 'resend'")
    ) {
      const attempt = state.attempts.find(
        (item) =>
          item.kind === 'resend' &&
          item.status === 'prepared' &&
          item.operationId === params[3] &&
          item.signature === params[5],
      );
      if (!attempt) return { rows: [], rowCount: 0 };
      attempt.status = params[4] as 'paid' | 'failed';
      return { rows: [], rowCount: 1 };
    }
    if (statement.includes("SET status = 'processing'")) {
      if (!state.row) return { rows: [], rowCount: 0 };
      state.row = {
        ...state.row,
        status: 'processing',
        tx_signature: params[3],
        signed_transaction: params[4],
      };
      return { rows: [{ ...state.row }], rowCount: 1 };
    }
    if (statement.includes('INSERT INTO daily_reward_payout_moderation_audit')) {
      state.audit.push({ sql: statement, params });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  return {
    state,
    query,
    release,
    connect: vi.fn(async () => ({ query, release })),
    poolQuery: vi.fn(async (_sql: string, _params: unknown[] = []) => ({
      // Widened from the inferred never[] so a per-test mockResolvedValueOnce can
      // hand back real rows (claimOwedPrizes returns them).
      rows: [] as Record<string, unknown>[],
      rowCount: 0,
    })),
  };
});

vi.mock('../server/db', () => ({
  ELIGIBLE_ACCOUNT_SQL: 'a.banned_at IS NULL',
  pool: { query: h.poolQuery, connect: h.connect },
}));
vi.mock('../server/realm', () => ({
  REALM: 'test-realm',
  REALM_DIRECTORY: [{ name: 'test-realm', url: '', type: 'Normal' }],
}));

import { PgDailyRewardDb } from '../server/daily_rewards_db';

// Only columns db.ts creates. This fixture used to carry the retired payment
// runner's wallet, fiat and transaction columns, which is how the SELECTs in
// voidPayout and restorePayout went on naming them long after the schema
// dropped them: this fake answers by statement substring and cannot see a
// column that does not exist.
// tests/daily_rewards_payout_moderation_schema.test.ts is the suite that can.
function payout(status: string): Record<string, unknown> {
  return {
    day: '2026-07-14',
    realm: 'test-realm',
    rank: 1,
    account_id: 42,
    username: 'alice',
    points: 500,
    prize_percent: '0.2',
    prize_copper: '500000',
    status,
    paid_at: null,
    void_reason: null,
    voided_by_id: null,
    voided_by_username: null,
    voided_at: null,
  };
}

describe('daily reward payout moderation persistence', () => {
  beforeEach(() => {
    h.state.row = payout('pending');
    h.state.audit.length = 0;
    h.state.attempts.length = 0;
    h.query.mockClear();
    h.connect.mockClear();
    h.release.mockClear();
    h.poolQuery.mockClear();
  });

  it.each(['pending', 'failed'])(
    'atomically voids a %s payout and appends an audit row',
    async (status) => {
      h.state.row = payout(status);

      const result = await new PgDailyRewardDb().voidPayout(
        '2026-07-14',
        1,
        'Payment requires manual review',
        { id: 'operator-7', username: 'moderator' },
      );

      expect(result.outcome).toBe('updated');
      if (result.outcome === 'updated') {
        expect(result.payout).toMatchObject({
          status: 'voided',
          voidReason: 'Payment requires manual review',
          voidedById: 'operator-7',
          voidedByUsername: 'moderator',
          voidedAt: '2026-07-15T01:02:03.000Z',
        });
        // Makes the fixture's column NAMES load-bearing here too: a key the
        // schema does not have yields Number(undefined) and fails. Without it
        // the fixture above is inert and could spell anything.
        expect(result.payout.prizeCopper).toBe(500000);
      }
      expect(h.state.audit).toHaveLength(1);
      expect(h.state.audit[0].params).toEqual([
        '2026-07-14',
        'test-realm',
        1,
        42,
        'void',
        status,
        'voided',
        'Payment requires manual review',
        'operator-7',
        'moderator',
      ]);
      expect(h.query.mock.calls.map(([sql]) => String(sql))).toEqual(
        expect.arrayContaining(['BEGIN', 'COMMIT']),
      );
      expect(h.release).toHaveBeenCalledOnce();
    },
  );

  it('protects paid payouts from voiding without writing audit history', async () => {
    h.state.row = payout('paid');

    const result = await new PgDailyRewardDb().voidPayout('2026-07-14', 1, 'Too late', {
      id: 'operator-7',
      username: 'moderator',
    });

    expect(result).toEqual({ outcome: 'invalid_status', status: 'paid' });
    expect(h.state.row.status).toBe('paid');
    expect(h.state.audit).toEqual([]);
  });

  it('atomically restores only voided payouts to pending and retains the void reason in audit', async () => {
    h.state.row = {
      ...payout('voided'),
      void_reason: 'Duplicate winner account',
      voided_by_id: 'operator-7',
      voided_by_username: 'moderator',
      voided_at: new Date('2026-07-15T01:02:03.000Z'),
    };

    const result = await new PgDailyRewardDb().restorePayout('2026-07-14', 1, {
      id: 'operator-8',
      username: 'reviewer',
    });

    expect(result.outcome).toBe('updated');
    if (result.outcome === 'updated') {
      expect(result.payout).toMatchObject({
        status: 'pending',
        voidReason: null,
        voidedById: null,
        voidedByUsername: null,
        voidedAt: null,
      });
      expect(result.payout.prizeCopper).toBe(500000);
    }
    expect(h.state.audit).toHaveLength(1);
    expect(h.state.audit[0].params).toEqual([
      '2026-07-14',
      'test-realm',
      1,
      42,
      'restore',
      'voided',
      'pending',
      'Duplicate winner account',
      'operator-8',
      'reviewer',
    ]);
  });

  it('keeps voided and already-paid prizes out of the outstanding-work readout', async () => {
    const db = new PgDailyRewardDb();
    await db.pendingPayouts(20);

    const pendingSql = String(h.poolQuery.mock.calls[0][0]);
    // Exactly 'pending', so neither a delivered prize nor one a moderator struck
    // can reappear as outstanding work.
    expect(pendingSql).toContain("p.status = 'pending'");
    expect(pendingSql).not.toContain("'voided'");
    expect(pendingSql).toContain('p.realm = $1');
  });

  it('optionally filters pending work by day before ordering and limiting it', async () => {
    const db = new PgDailyRewardDb();
    await db.pendingPayouts(100, '2026-07-14');

    const sql = String(h.poolQuery.mock.calls[0][0]);
    expect(sql).toContain('p.day = $2');
    expect(sql.indexOf('p.day = $2')).toBeLessThan(sql.indexOf('ORDER BY'));
    expect(h.poolQuery.mock.calls[0][1]).toEqual(['test-realm', '2026-07-14', 100]);
  });

  it('scopes payout history to the active realm', async () => {
    await new PgDailyRewardDb().recentPayouts(25);
    const [sql, params] = h.poolQuery.mock.calls[0];
    expect(String(sql)).toContain('WHERE p.realm = $1');
    expect(params).toEqual(['test-realm', 25]);
  });

  it('claims owed prizes and marks them paid in ONE statement, so two joins cannot both collect', async () => {
    h.poolQuery.mockResolvedValueOnce({
      rows: [{ day: '2026-07-14', rank: 1, prize_copper: '500000' }],
      rowCount: 1,
    });
    const claimed = await new PgDailyRewardDb().claimOwedPrizes(7);

    const [sql, params] = h.poolQuery.mock.calls[0];
    const text = String(sql);
    // The whole anti-double-pay argument rests on this being one statement: the
    // rows are selected BY the UPDATE that marks them, never read then written,
    // so a racing second join sees them already out of 'pending'.
    expect(text).toContain('UPDATE daily_reward_payouts');
    expect(text).toContain("SET status = 'paid'");
    expect(text).toContain("p.status = 'pending'");
    expect(text).toContain('RETURNING');
    expect(text).not.toContain('SELECT p.day, p.realm, p.rank');
    expect(params).toEqual([7, 'test-realm']);
    // NUMERIC/BIGINT arrives from pg as a string; it must reach the caller as a
    // number, or the mail attachment silently becomes a string concat.
    expect(claimed).toEqual([{ day: '2026-07-14', rank: 1, prizeCopper: 500000 }]);
  });

  it('holds a banned or excluded winner PENDING rather than forfeiting the prize', async () => {
    h.poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await new PgDailyRewardDb().claimOwedPrizes(7);

    const text = String(h.poolQuery.mock.calls[0][0]);
    // Both moderation gates fence the CLAIM, not a delete: an account that is
    // banned when it logs in keeps its row owed, so lifting the ban pays it out
    // at the next join with no operator action.
    expect(text).toContain('EXISTS (SELECT 1 FROM accounts a');
    expect(text).toContain('NOT EXISTS (SELECT 1 FROM daily_reward_excluded_accounts b');
    expect(text).toContain('p.prize_copper > 0');
    expect(text).not.toContain('DELETE');
  });
});
