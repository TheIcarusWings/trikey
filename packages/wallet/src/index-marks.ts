/**
 * The phone's own bound on the next address indexes the guardian reports (`wallet.sync`'s `nextReceiveIndex` and
 * `nextChangeIndex`; security review 2026-11, sweep 2, finding 8).
 *
 * The phone hands out receive addresses and sends change at those indexes. A guardian that lies (it holds one key of
 * three) could report an index near the protocol's limit (100,000): coins sent there are still the owner's, but a later
 * gap-limit scan (Replace guardian with the old box gone, a stray-coin sweep, the descriptor restored in another wallet)
 * would not find them. So the phone keeps, per chain, the highest index it knows is used (`IndexMarks`): coins a sync
 * listed and its own payments' outputs. A reported next index more than `INDEX_GAP` past that mark is cut to the mark
 * plus `INDEX_GAP`, so a scan with the usual gap of 20 still reaches every address the phone uses. Addresses handed out
 * do not count: a coin received there is listed by the sync that lets the phone spend it.
 *
 * What it does not cover: a coin received at a far address and spent elsewhere before this phone ever synced it (the
 * phone then reuses an address within the bound), and a guardian that lists a made-up coin at a far index (a visible
 * lie: a balance that cannot be spent). Pure functions; `wallet.ts` stores the marks.
 */

/** How far past the highest known used index the phone goes: the usual gap limit, as the guardian's own scans use. */
export const INDEX_GAP = 20;

/** Per chain, the highest address index known used (-1: none). */
export interface IndexMarks {
  receive: number;
  change: number;
}

export interface NextIndexes {
  nextReceiveIndex: number;
  nextChangeIndex: number;
}

/** Marks that trust `next` as it is: for the first sync of a wallet, when the phone knows nothing of its own yet. */
export function marksFromNext(next: NextIndexes): IndexMarks {
  return { receive: Math.max(-1, next.nextReceiveIndex - 1), change: Math.max(-1, next.nextChangeIndex - 1) };
}

/** `marks` raised to every index in `used` (coins, own payments' outputs). Never lowers them. */
export function raiseMarks(marks: IndexMarks, used: Iterable<{ chain: 0 | 1; index: number }>): IndexMarks {
  let { receive, change } = marks;
  for (const u of used) {
    if (u.chain === 0) receive = Math.max(receive, u.index);
    else change = Math.max(change, u.index);
  }
  return receive === marks.receive && change === marks.change ? marks : { receive, change };
}

/**
 * `next` with each index cut to at most `INDEX_GAP` past its mark. `capped` lists each chain that was cut, with what was
 * reported, for a log line.
 */
export function boundNext<T extends NextIndexes>(next: T, marks: IndexMarks): { next: T; capped: { chain: 0 | 1; reported: number; used: number }[] } {
  const capped: { chain: 0 | 1; reported: number; used: number }[] = [];
  const cap = (chain: 0 | 1, reported: number, mark: number) => {
    const max = mark + INDEX_GAP;
    if (reported <= max) return reported;
    capped.push({ chain, reported, used: max });
    return max;
  };
  const nextReceiveIndex = cap(0, next.nextReceiveIndex, marks.receive);
  const nextChangeIndex = cap(1, next.nextChangeIndex, marks.change);
  return { next: capped.length ? { ...next, nextReceiveIndex, nextChangeIndex } : next, capped };
}
