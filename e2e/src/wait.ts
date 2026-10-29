export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Polls `fn` until it returns something truthy. Real infrastructure answers in its own time (Electrs indexes a block a
 * moment after the node has it), so the tests wait for the state they expect instead of sleeping.
 */
export async function waitFor<T>(
  fn: () => T | undefined | false | null | Promise<T | undefined | false | null>,
  what: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const start = Date.now();
  let lastError: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      lastError = undefined;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${lastError ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})` : ''}`);
    await sleep(opts.intervalMs ?? 100);
  }
}
