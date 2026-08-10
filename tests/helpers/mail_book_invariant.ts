// The PostOffice book-versus-index oracle: after any mutation, do the MailIndex
// buckets still exactly cover the canonical book, and does the bucketed
// deliveredFor still equal the whole-book scan it replaced?
//
// Why this needs its own oracle. Since every read moved onto the buckets
// (deliveredFor, mailboxHoldsItem, storedCountFor), the book and the index can
// disagree and NOTHING in the suite notices: every assertion downstream reads
// the index, so a desynced PostOffice is self-consistent and green. The only
// pre-existing book-vs-derived check was mail.test.ts's unreadOracle, and that
// covers the unread COUNT alone, which a wrong-bucket letter can leave exactly
// right. The failure a desync produces is not a wrong badge number any more: an
// untracked or mis-bucketed letter DOES NOT EXIST to the post, so it cannot be
// taken or deleted (its coin and parcels are stranded), and mailboxHoldsItem
// reporting false makes playerHoldsQuestItem false, which mints a DUPLICATE
// quest item on the re-accept path.
//
// tests/mail_index.test.ts drives MailIndex against its own reference model in
// isolation; this is the other half, over the real PostOffice, where the
// track/untrack/rekey discipline actually has to be applied by hand at fifteen
// mutation sites.

import { expect } from 'vitest';
import type { MailMessage } from '../../src/sim/mail/post_office';
import type { PlayerMeta, Sim } from '../../src/sim/sim';

// The book plus the private members the oracle has to read. `deliveredFor` and
// `index` are module-private by design; reaching them here is the point (the
// oracle must see the derived state, not the surface built on it).
interface PostOfficeInternals {
  readonly mail: readonly MailMessage[];
  mailKeyFor(meta: PlayerMeta): string;
  deliveredFor(meta: PlayerMeta): MailMessage[];
  index: {
    buckets: Map<string, MailMessage[]>;
    countFor(key: string): number;
    bucketFor(key: string): readonly MailMessage[];
  };
}

const internals = (sim: Sim): PostOfficeInternals =>
  sim.postOffice as unknown as PostOfficeInternals;

const idsOf = (letters: readonly MailMessage[]): number[] =>
  letters.map((m) => m.id).sort((a, b) => a - b);

/**
 * Assert the Ravenpost's derived index still describes its canonical book.
 * Call it after every scripted mutation; `label` names the mutation so a
 * failure says which one broke the invariant rather than only that one did.
 */
export function expectMailBookMatchesIndex(sim: Sim, label: string): void {
  const po = internals(sim);
  const book = po.mail;

  // 1. The buckets hold exactly as many entries as the book holds letters.
  //    Summed over every key the index knows, so a letter filed under a key no
  //    longer in the book still counts against the total.
  let bucketed = 0;
  for (const key of po.index.buckets.keys()) bucketed += po.index.countFor(key);
  expect(bucketed, `${label}: bucket entries vs book length`).toBe(book.length);

  // 2. ...and each letter sits exactly once in the bucket its OWN recipientKey
  //    names. Check 1 alone cannot see a mis-filed letter (the total is
  //    unchanged when one letter is filed under a stranger's key); the two
  //    together say the buckets cover the book exactly, with nothing
  //    double-filed and nothing stale left behind.
  for (const m of book) {
    const filed = po.index.bucketFor(m.recipientKey).filter((x) => x === m).length;
    expect(filed, `${label}: letter ${m.id} filed under its own key ${m.recipientKey}`).toBe(1);
  }

  // 3. The bucket-union deliveredFor still equals the naive whole-book scan it
  //    replaced, for every live player, under the historical dual-key rule
  //    (stable mail key OR display name). Compared as id SETS: the union's
  //    order is deliberately not book order (see the deliveredFor comment).
  const now = sim.time;
  for (const meta of sim.players.values()) {
    const key = po.mailKeyFor(meta);
    const naive = book.filter(
      (m) => (m.recipientKey === key || m.recipientKey === meta.name) && now >= m.deliverAt,
    );
    expect(idsOf(po.deliveredFor(meta)), `${label}: deliveredFor(${meta.name})`).toEqual(
      idsOf(naive),
    );
  }
}
