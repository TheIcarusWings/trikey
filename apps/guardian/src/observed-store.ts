/**
 * A `StateStore` wrapper that remembers the last state it loaded or saved.
 *
 * The policy engine keeps its recovery records (the stored sweep PSBT, the
 * alert recipients, `cancelledBy`, ...) private and only exposes summaries.
 * The service needs some of those fields (to check a sweep against the chain,
 * to fill alert fields `DueAlert` lacks, to answer `recovery.status` for an
 * older recovery), so it reads them here, read-only. The engine replaces its
 * state object on every mutation and never mutates one after saving it, so
 * what this holds always matches the engine's current state.
 */
import type { GuardianState, StateStore } from './policy/index.js';

export class ObservedStore implements StateStore {
  private last?: GuardianState;

  constructor(private readonly inner: StateStore) {}

  async load(): Promise<GuardianState | undefined> {
    const s = await this.inner.load();
    this.last = s;
    return s;
  }

  async save(state: GuardianState): Promise<void> {
    await this.inner.save(state);
    this.last = state;
  }

  /** The engine's current state (read-only; never modify it). */
  get state(): Readonly<GuardianState> | undefined {
    return this.last;
  }
}
