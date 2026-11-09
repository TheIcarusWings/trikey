/**
 * index-marks.ts: the phone's bound on the next address indexes a guardian reports (security review 2026-11, sweep 2,
 * finding 8). Pure.
 */
import { describe, expect, it } from 'vitest';
import { INDEX_GAP, boundNext, marksFromNext, raiseMarks } from '../src/index-marks.js';

describe('index marks', () => {
  it('the first sync is trusted as it is', () => {
    expect(marksFromNext({ nextReceiveIndex: 0, nextChangeIndex: 0 })).toEqual({ receive: -1, change: -1 });
    expect(marksFromNext({ nextReceiveIndex: 57, nextChangeIndex: 12 })).toEqual({ receive: 56, change: 11 });
  });

  it('marks rise with what is used and never fall', () => {
    const m = { receive: 4, change: 2 };
    expect(raiseMarks(m, [{ chain: 0, index: 9 }, { chain: 1, index: 1 }])).toEqual({ receive: 9, change: 2 });
    expect(raiseMarks(m, [{ chain: 0, index: 3 }])).toBe(m);
  });

  it('a next index more than a gap past the mark is cut to the mark plus the gap, and reported', () => {
    const snap = { nextReceiveIndex: 99_999, nextChangeIndex: 3, gapLimit: 1000 };
    const r = boundNext(snap, { receive: 4, change: 2 });
    expect(r.next).toEqual({ nextReceiveIndex: 4 + INDEX_GAP, nextChangeIndex: 3, gapLimit: 1000 });
    expect(r.capped).toEqual([{ chain: 0, reported: 99_999, used: 4 + INDEX_GAP }]);
    // Nothing used yet: index 19 at most, which a scan with a gap of 20 still finds.
    expect(boundNext({ nextReceiveIndex: 500, nextChangeIndex: 500 }, { receive: -1, change: -1 }).next).toEqual({ nextReceiveIndex: 19, nextChangeIndex: 19 });
  });

  it('within the bound nothing changes', () => {
    const snap = { nextReceiveIndex: 24, nextChangeIndex: 0 };
    const r = boundNext(snap, { receive: 4, change: -1 });
    expect(r.next).toBe(snap);
    expect(r.capped).toEqual([]);
  });
});
