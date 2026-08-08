import { beforeEach, describe, expect, it, vi } from 'vitest';

// The payout-moderation writes, executed against the schema boot ACTUALLY
// builds. tests/daily_rewards_payout_moderation_db.test.ts drives the same two
// functions through a fake that answers by statement substring, so it stays
// green no matter which columns the SQL names; that is how voidPayout and
// restorePayout went on selecting and clearing the retired payment runner's
// columns (RETIRED_PAYMENT_COLUMNS below) long after this fork's schema stopped
// creating any of them. Every call crashed with "column does not exist" on a
// fresh database and only worked against one migrated from the web3-era build.
//
// So this suite builds the column set by APPLYING ensureSchema's own DDL (pg is
// mocked, no live database), then runs the real PgDailyRewardDb methods against
// a client that refuses any column that schema does not have, the way Postgres
// would.
//
// SCOPE, stated so nobody reads this as a whole-module SQL validator: it covers
// the statements voidPayout and restorePayout execute, and it resolves the four
// column-reference forms listed at validate(). The other statements naming this
// table (recentPayouts, pendingPayouts, finalizeDay, claimOwedPrizes, and the
// exported DAILY_REWARD_WINNER_PAYOUTS_SQL) reference the daily_reward_excluded_accounts
// VIEW, which the DDL folding here does not model, so they are deliberately not
// driven through it.
const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test/test';
  const FIXED_NOW = new Date('2026-07-15T01:02:03.000Z');
  // Column sets keyed by table name, built from the DDL ensureSchema applies.
  const schema = new Map<string, Set<string>>();
  const state = {
    mode: 'ddl' as 'ddl' | 'serve',
    // The single daily_reward_payouts row the serve mode holds.
    row: null as Record<string, unknown> | null,
    audit: [] as Array<{ table: string; columns: string[]; params: unknown[] }>,
  };

  // Words that follow a table name without being an alias. `as` is deliberately
  // NOT here: the FROM/JOIN pattern consumes an optional AS instead, because
  // skipping the binding is indistinguishable from resolving zero references,
  // and `FROM daily_reward_payouts AS p` would then disengage the whole check
  // while every test still passed.
  const SQL_KEYWORDS = new Set(['set', 'where', 'values', 'returning', 'on', 'using']);
  const CONSTRAINT_LEADS = new Set([
    'primary',
    'unique',
    'foreign',
    'check',
    'constraint',
    'exclude',
  ]);

  /**
   * Split a parenthesized SQL list on its TOP-level commas. String-literal
   * aware: `mute_ladder_seconds INT[] NOT NULL DEFAULT '{600,3600,86400}'` in
   * the real boot DDL puts commas at depth 0 inside a literal, and a
   * paren-depth-only split turns each one into a phantom column.
   */
  const splitTopLevel = (body: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    let quoted = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quoted) {
        if (ch === "'") quoted = false;
        continue;
      }
      if (ch === "'") quoted = true;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        out.push(body.slice(start, i));
        start = i + 1;
      }
    }
    out.push(body.slice(start));
    return out;
  };

  /**
   * Blank out `--` line comments outside string literals, preserving offsets so
   * the regex match indices the callers carry stay valid. A comment inside a
   * CREATE TABLE body is worse than a stray literal: the split lands mid-comment
   * and its first word becomes a phantom column while a real one is swallowed.
   */
  const stripLineComments = (sql: string): string => {
    let out = '';
    let quoted = false;
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (quoted) {
        out += ch;
        if (ch === "'") quoted = false;
        continue;
      }
      if (ch === "'") {
        out += ch;
        quoted = true;
        continue;
      }
      if (ch === '-' && sql[i + 1] === '-') {
        while (i < sql.length && sql[i] !== '\n') {
          out += ' ';
          i++;
        }
        if (i < sql.length) out += '\n';
        continue;
      }
      out += ch;
    }
    return out;
  };

  /** The balanced body of the parenthesized list that opens at `open`. */
  const balancedBody = (sql: string, open: number): string => {
    let depth = 0;
    for (let i = open; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') {
        depth--;
        if (depth === 0) return sql.slice(open + 1, i);
      }
    }
    return '';
  };

  /** Fold one DDL blob (a multi-statement boot string) into `schema`. */
  const applyDdl = (raw: string): void => {
    const sql = stripLineComments(raw);
    const create = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(/gi;
    for (let m = create.exec(sql); m; m = create.exec(sql)) {
      const table = m[1].toLowerCase();
      const columns = schema.get(table) ?? new Set<string>();
      for (const item of splitTopLevel(balancedBody(sql, m.index + m[0].length - 1))) {
        const name = item.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        if (!name || CONSTRAINT_LEADS.has(name)) continue;
        columns.add(name);
      }
      schema.set(table, columns);
    }
    const alter =
      /ALTER TABLE ([a-z_][a-z0-9_]*) ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi;
    for (let m = alter.exec(sql); m; m = alter.exec(sql)) {
      const columns = schema.get(m[1].toLowerCase()) ?? new Set<string>();
      columns.add(m[2].toLowerCase());
      schema.set(m[1].toLowerCase(), columns);
    }
  };

  /** Postgres' own undefined-column failure, so a miss reads like production. */
  const undefinedColumn = (table: string, column: string): Error => {
    const err = new Error(`column "${column}" of relation "${table}" does not exist`) as Error & {
      code?: string;
    };
    err.code = '42703';
    return err;
  };

  const requireColumn = (table: string, column: string): void => {
    const columns = schema.get(table);
    if (!columns) throw new Error(`relation "${table}" does not exist`);
    if (!columns.has(column)) throw undefinedColumn(table, column);
  };

  /**
   * Resolve every column reference the statement makes against the built
   * schema. Scope: alias-qualified references, UPDATE SET targets, RETURNING
   * lists, and INSERT column lists. That covers every form the two payout
   * moderation statements name a column on, and each is unambiguous to read out
   * of the text. An UNQUALIFIED predicate is knowingly outside it (both UPDATEs
   * end in `WHERE day = $1 AND realm = $2 AND rank = $3`, which reads the same
   * as a parameter comparison on any table), so the raw-text pin in the void
   * and restore cases is what backstops that half: it needs no parser at all.
   */
  const validate = (sql: string): void => {
    // Alias bindings, from the two forms these statements use. `FOR UPDATE OF p`
    // is why UPDATE is anchored to the statement head rather than scanned for:
    // unanchored it binds the alias to a table named "OF".
    const bindings: Array<[string, string]> = [];
    const from = /(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z][a-z0-9_]*)\b/gi;
    for (let m = from.exec(sql); m; m = from.exec(sql)) bindings.push([m[1], m[2]]);
    const updateAlias = /^\s*UPDATE\s+([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z][a-z0-9_]*)\b/i.exec(
      sql,
    );
    if (updateAlias) bindings.push([updateAlias[1], updateAlias[2]]);
    for (const [table, alias] of bindings) {
      if (SQL_KEYWORDS.has(alias.toLowerCase())) continue;
      const refs = new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'gi');
      for (let r = refs.exec(sql); r; r = refs.exec(sql)) {
        requireColumn(table.toLowerCase(), r[1].toLowerCase());
      }
    }
    const update = /^\s*UPDATE\s+([a-z_][a-z0-9_]*)\b/i.exec(sql);
    const insert = /INSERT INTO\s+([a-z_][a-z0-9_]*)\s*\(/i.exec(sql);
    if (update) {
      const table = update[1].toLowerCase();
      const setStart = sql.search(/\bSET\b/i);
      const setEnd = sql.search(/\bWHERE\b/i);
      if (setStart >= 0) {
        const clause = sql.slice(setStart + 3, setEnd > setStart ? setEnd : undefined);
        for (const assignment of splitTopLevel(clause)) {
          const target = /^\s*([a-z_][a-z0-9_]*)\s*=/i.exec(assignment);
          if (target) requireColumn(table, target[1].toLowerCase());
        }
      }
    }
    if (insert) {
      const table = insert[1].toLowerCase();
      const body = balancedBody(sql, insert.index + insert[0].length - 1);
      for (const item of splitTopLevel(body)) {
        requireColumn(table, item.trim().toLowerCase());
      }
    }
    // Hoisted out of the UPDATE arm on purpose: an INSERT can carry a RETURNING
    // too, and nesting the check made that form silently unvalidated.
    const writeTable = update?.[1].toLowerCase() ?? insert?.[1].toLowerCase();
    const returning = /\bRETURNING\b([\s\S]*)$/i.exec(sql);
    if (writeTable && returning) {
      for (const item of splitTopLevel(returning[1])) {
        const name = /^\s*(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*$/i.exec(item);
        if (name) requireColumn(writeTable, name[1].toLowerCase());
      }
    }
  };

  /** Evaluate one SET right-hand side against the statement's parameters. */
  const assignedValue = (expr: string, params: unknown[]): unknown => {
    const text = expr.trim();
    const placeholder = /^\$(\d+)$/.exec(text);
    if (placeholder) return params[Number(placeholder[1]) - 1];
    if (/^now\(\)$/i.test(text)) return FIXED_NOW;
    if (/^null$/i.test(text)) return null;
    const literal = /^'(.*)'$/.exec(text);
    return literal ? literal[1] : text;
  };

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (state.mode === 'ddl') {
      applyDdl(text);
      // ensureSchema asserts the core tables landed and probes for an invalid
      // concurrent-index carcass; answer both so boot completes.
      if (text.includes('indisvalid')) return { rows: [], rowCount: 0 };
      if (text.includes('to_regclass')) {
        return { rows: [{ reg: 'public.rate_limits' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text.trim())) return { rows: [], rowCount: 0 };
    validate(text);

    if (text.includes('FROM daily_reward_payouts p') && text.includes('FOR UPDATE OF p')) {
      if (!state.row) return { rows: [], rowCount: 0 };
      // Project onto exactly the columns the SELECT asked for, so a statement
      // that stops selecting one cannot keep reading it off the fixture.
      const selected = [...text.matchAll(/\bp\.([a-z_][a-z0-9_]*)/g)].map((m) => m[1]);
      const projected: Record<string, unknown> = {};
      for (const column of selected) projected[column] = state.row[column];
      return { rows: [projected], rowCount: 1 };
    }
    if (/^\s*UPDATE\s+daily_reward_payouts/i.test(text)) {
      // Mirror the statement's own status guard: both transitions are fenced on
      // the status they claim to move away from.
      const wanted = text.includes("SET status = 'voided'") ? ['pending', 'failed'] : ['voided'];
      const row = state.row;
      if (!row || !wanted.includes(String(row.status))) {
        return { rows: [], rowCount: 0 };
      }
      const clause = text.slice(text.search(/\bSET\b/i) + 3, text.search(/\bWHERE\b/i));
      for (const assignment of splitTopLevel(clause)) {
        const parts = /^\s*([a-z_][a-z0-9_]*)\s*=([\s\S]*)$/i.exec(assignment);
        if (parts) row[parts[1]] = assignedValue(parts[2], params);
      }
      const returning = /\bRETURNING\b([\s\S]*)$/i.exec(text);
      const projected: Record<string, unknown> = {};
      for (const item of returning ? splitTopLevel(returning[1]) : []) {
        const name = /^\s*(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*$/i.exec(item);
        if (name) projected[name[1]] = row[name[1]];
      }
      return { rows: [projected], rowCount: 1 };
    }
    const insert = /INSERT INTO\s+([a-z_][a-z0-9_]*)\s*\(/i.exec(text);
    if (insert) {
      const body = balancedBody(text, insert.index + insert[0].length - 1);
      state.audit.push({
        table: insert[1],
        columns: splitTopLevel(body).map((item) => item.trim()),
        params,
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const release = vi.fn();
  return {
    FIXED_NOW,
    schema,
    state,
    query,
    validate,
    release,
    connect: vi.fn(async () => ({ query, release })),
  };
});

vi.mock('pg', () => ({
  Pool: vi.fn(function Pool() {
    return { query: h.query, connect: h.connect };
  }),
  Client: vi.fn(function Client() {
    return {
      connect: vi.fn(async () => undefined),
      query: h.query,
      end: vi.fn(async () => undefined),
    };
  }),
}));

import { PgDailyRewardDb } from '../server/daily_rewards_db';
import { ensureSchema } from '../server/db';
import { REALM } from '../server/realm';

const DAY = '2026-07-14';

// Spelled ONCE, and kept on ONE line: the counted pin in
// tests/no_web3_regression.test.ts counts LINES containing a token, so this
// suite measures as a single site per token rather than one per assertion. A
// reformat that wraps this array moves three of that guard's four numbers.
const RETIRED_PAYMENT_COLUMNS = ['prize_usd', 'tx_signature', 'signed_transaction', 'error'];

/**
 * Every column server/db.ts creates on daily_reward_payouts: the CREATE TABLE
 * body plus the four ALTER TABLE ADD COLUMNs. Pinned as an EXACT set rather
 * than a floor, in both directions on purpose. A floor under the real count is
 * what lets a quietly narrowed surface hide (tests/CLAUDE.md), and this set is
 * also the only thing that would notice the DDL parser above drifting on this
 * table. A legitimate new column lands here in the same change.
 */
const PAYOUT_COLUMNS = [
  'account_id',
  'created_at',
  'day',
  'paid_at',
  'points',
  'prize_copper',
  'prize_percent',
  'rank',
  'realm',
  'status',
  'updated_at',
  'username',
  'void_reason',
  'voided_at',
  'voided_by_id',
  'voided_by_username',
];

/** Executed SQL, for the parser-independent half of the guard. */
function executedSql(): string[] {
  return h.query.mock.calls.map(([sql]) => String(sql));
}

/** A payouts row holding ONLY columns the built schema declares. */
function freshRow(status: string): Record<string, unknown> {
  const columns = h.schema.get('daily_reward_payouts');
  if (!columns) throw new Error('daily_reward_payouts was never created by ensureSchema');
  const row: Record<string, unknown> = {};
  for (const column of columns) row[column] = null;
  return {
    ...row,
    day: DAY,
    realm: REALM,
    rank: 1,
    account_id: 42,
    username: 'alice',
    points: 500,
    prize_percent: '0.2',
    prize_copper: '500000',
    status,
    created_at: h.FIXED_NOW,
    updated_at: h.FIXED_NOW,
  };
}

describe('daily reward payout moderation against the schema boot builds', () => {
  beforeEach(async () => {
    if (h.schema.size === 0) {
      h.state.mode = 'ddl';
      await ensureSchema();
      h.state.mode = 'serve';
    }
    h.state.row = freshRow('pending');
    h.state.audit.length = 0;
    h.query.mockClear();
    h.release.mockClear();
  });

  it('builds exactly the daily_reward_payouts columns db.ts declares, and none of the retired ones', () => {
    const columns = h.schema.get('daily_reward_payouts');
    expect(columns).toBeDefined();
    expect([...(columns as Set<string>)].sort()).toEqual([...PAYOUT_COLUMNS].sort());
    // Stated separately from the set above: this is the CLAIM, and it must not
    // rest on a reader noticing four names are absent from a sixteen-name list.
    for (const retired of RETIRED_PAYMENT_COLUMNS) {
      expect(columns).not.toContain(retired);
    }
  });

  it('rejects a statement naming a column the built schema lacks, per retired column', () => {
    // The guard's own premise. Without this, a validate() that quietly resolved
    // nothing would let both regressions back in under a green suite. One case
    // per column, so a partial re-introduction cannot hide behind the others.
    for (const retired of RETIRED_PAYMENT_COLUMNS) {
      expect(() =>
        h.validate(`SELECT p.${retired} FROM daily_reward_payouts p WHERE p.rank = $1`),
      ).toThrow(`column "${retired}" of relation "daily_reward_payouts" does not exist`);
      expect(() =>
        h.validate(`UPDATE daily_reward_payouts SET ${retired} = NULL WHERE rank = $1`),
      ).toThrow(`column "${retired}" of relation "daily_reward_payouts" does not exist`);
      // An AS-aliased FROM is the same statement to Postgres, so it must be the
      // same statement here. It was not: `as` counted as the alias, the binding
      // was skipped, and the whole check silently resolved nothing.
      expect(() =>
        h.validate(`SELECT p.${retired} FROM daily_reward_payouts AS p WHERE p.rank = $1`),
      ).toThrow(`column "${retired}" of relation "daily_reward_payouts" does not exist`);
      // An INSERT ... RETURNING is not an UPDATE, and used to escape the check
      // because the RETURNING scan was nested inside the UPDATE arm.
      expect(() =>
        h.validate(`INSERT INTO daily_reward_payouts (day) VALUES ($1) RETURNING ${retired}`),
      ).toThrow(`column "${retired}" of relation "daily_reward_payouts" does not exist`);
    }
    // ... and resolves the columns that ARE there, so it is not a blanket throw.
    expect(() =>
      h.validate(`SELECT p.prize_copper FROM daily_reward_payouts AS p WHERE p.rank = $1`),
    ).not.toThrow();
  });

  it.each(['pending', 'failed'])(
    'voids a %s payout without naming a missing column',
    async (status) => {
      h.state.row = freshRow(status);

      const result = await new PgDailyRewardDb().voidPayout(DAY, 1, 'Duplicate winner account', {
        id: 'operator-7',
        username: 'moderator',
      });

      expect(result.outcome).toBe('updated');
      if (result.outcome === 'updated') {
        expect(result.payout).toMatchObject({
          day: DAY,
          rank: 1,
          accountId: 42,
          username: 'alice',
          status: 'voided',
          voidReason: 'Duplicate winner account',
          voidedById: 'operator-7',
          voidedByUsername: 'moderator',
          voidedAt: h.FIXED_NOW.toISOString(),
        });
        // Decisive on the SELECT list: the fixture only answers columns the
        // statement asked for, so dropping prize_copper from it lands NaN here.
        expect(result.payout.prizeCopper).toBe(500000);
      }
      expect(h.state.row?.status).toBe('voided');
      expect(h.state.audit).toHaveLength(1);
      expect(h.state.audit[0].table).toBe('daily_reward_payout_moderation_audit');
      expect(h.state.audit[0].params).toEqual([
        DAY,
        REALM,
        1,
        42,
        'void',
        status,
        'voided',
        'Duplicate winner account',
        'operator-7',
        'moderator',
      ]);
      expect(h.release).toHaveBeenCalledOnce();
      // Parser-independent half of the guard: whatever validate() can or cannot
      // resolve out of a statement, no statement this call executed may SPELL a
      // retired column at all. A weakness in the resolver cannot route around
      // this, and it covers the WHERE clause the resolver knowingly skips.
      for (const sql of executedSql()) {
        for (const retired of RETIRED_PAYMENT_COLUMNS) {
          expect(sql).not.toContain(retired);
        }
      }
    },
  );

  it('restores a voided payout without clearing a column the schema never had', async () => {
    h.state.row = {
      ...freshRow('voided'),
      void_reason: 'Duplicate winner account',
      voided_by_id: 'operator-7',
      voided_by_username: 'moderator',
      voided_at: h.FIXED_NOW,
    };

    const result = await new PgDailyRewardDb().restorePayout(DAY, 1, {
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
      // The prize survives the round trip as copper: restoring owes the winner
      // the same in-game coin the finalizer split out.
      expect(result.payout.prizeCopper).toBe(500000);
    }
    expect(h.state.row?.status).toBe('pending');
    expect(h.state.row?.void_reason).toBeNull();
    expect(h.state.audit).toHaveLength(1);
    // The whole tuple, not just the reason: a restore that recorded action
    // 'void' or next_status 'voided' would otherwise read as correct here. The
    // void reason is carried into the audit row before it is cleared.
    expect(h.state.audit[0].params).toEqual([
      DAY,
      REALM,
      1,
      42,
      'restore',
      'voided',
      'pending',
      'Duplicate winner account',
      'operator-8',
      'reviewer',
    ]);
    for (const sql of executedSql()) {
      for (const retired of RETIRED_PAYMENT_COLUMNS) {
        expect(sql).not.toContain(retired);
      }
    }
  });

  it('surfaces an undefined column named ONLY by the SELECT list, not just by the UPDATE', async () => {
    // The axis the original bug lived on. paid_at is named by the SELECT and by
    // neither UPDATE, so this is the one case that can tell "the SELECT list is
    // checked" apart from "only the write half is checked". Deleting a column
    // both halves name would be satisfied by either one throwing.
    h.schema.get('daily_reward_payouts')?.delete('paid_at');
    try {
      await expect(
        new PgDailyRewardDb().voidPayout(DAY, 1, 'Duplicate winner account', {
          id: 'operator-7',
          username: 'moderator',
        }),
      ).rejects.toThrow('column "paid_at" of relation "daily_reward_payouts" does not exist');
    } finally {
      h.schema.get('daily_reward_payouts')?.add('paid_at');
    }
  });

  it('propagates the undefined-column failure to the caller and issues a ROLLBACK', async () => {
    // The production symptom this suite exists for: the 42703 must reach the
    // caller, never be swallowed into a "not_found" or a silent success, and
    // the transaction must be closed out rather than left open on the client.
    // Named for what this fake can prove: it has no transaction semantics, so
    // the ROLLBACK statement and the untouched row are the evidence, not a
    // replayed rollback.
    h.schema.get('daily_reward_payouts')?.delete('void_reason');
    try {
      await expect(
        new PgDailyRewardDb().voidPayout(DAY, 1, 'Duplicate winner account', {
          id: 'operator-7',
          username: 'moderator',
        }),
      ).rejects.toThrow('column "void_reason" of relation "daily_reward_payouts" does not exist');
    } finally {
      h.schema.get('daily_reward_payouts')?.add('void_reason');
    }
    expect(executedSql()).toContain('ROLLBACK');
    expect(executedSql()).not.toContain('COMMIT');
    // The row never moved: a failure that had already flipped it to 'voided'
    // would leave a struck payout behind with no audit trail explaining it.
    expect(h.state.row?.status).toBe('pending');
    expect(h.state.audit).toEqual([]);
    expect(h.release).toHaveBeenCalledOnce();
  });
});
