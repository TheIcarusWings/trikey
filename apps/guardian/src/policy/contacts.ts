/** Alert contacts before and after a change (both normalized: lowercase, sorted, distinct). */
export function contactsDelta(before: readonly string[], after: readonly string[]): { same: boolean; added: string[]; removed: string[] } {
  const b = new Set(before.map((c) => c.toLowerCase()));
  const a = new Set(after.map((c) => c.toLowerCase()));
  const added = [...a].filter((c) => !b.has(c)).sort();
  const removed = [...b].filter((c) => !a.has(c)).sort();
  return { same: !added.length && !removed.length, added, removed };
}
