/**
 * Completes guest wallets' recoveries (docs/design/family-hosting.md, section 5), as recovery-runner.ts does for the
 * host's wallet, without addresses:
 *
 * 1. Time, three ways (the engine checks again): the system clock, the chain's median time past and the block count.
 * 2. Coverage by the host's own Electrs, by the coins' OWN scripts (so nothing leaks): every input of the sweep is still
 *    unspent, and every ledger coin (a coin key 3 co-signed into existence) that is still unspent is in the sweep or in
 *    its `abandon` list. Coins received from outside cannot be checked here: that is the guest phone's job (it scans
 *    with its own chain source and a second server before it signs).
 *
 * Then the co-signed sweep goes to the slot's `slot.json`, is broadcast through the host's node (retried), and once a
 * node accepted it the slot rotates to the destination wallet.
 */
import { base64, hex } from '@scure/base';
import { parsePsbt } from '@trikey/core';
import { formatBtc, formatWhen } from '../alerts.js';
import type { Guardian } from '../guardian.js';
import { errorText } from '../log.js';
import type { HostedEngine } from './engine.js';
import type { Hosting } from './service.js';
import type { HostedRecoveryRecord, SlotRecord } from './types.js';
import { hostedRefusalText } from './handlers.js';

export interface HostedWait {
  recoveryId: string;
  reason: 'locked' | 'chain_unavailable' | 'chain_time' | 'sweep_incomplete' | 'sweep_inputs_missing' | 'refused';
  detail: string;
  since: number;
}

export class HostedRecoveryRunner {
  /** Per slot: why its recovery has not completed yet, once its delay is over. */
  readonly waits = new Map<string, HostedWait>();

  constructor(
    private readonly g: Guardian,
    private readonly h: Hosting,
  ) {}

  async run(): Promise<void> {
    for (const { slot, engine } of this.h.liveSlots()) {
      try {
        const rec = engine.activeRecord();
        if (!rec || this.g.clock.now() < rec.readyAt) this.waits.delete(slot.slotId);
        else
          await this.g.recoveryMutex.run(async () => {
            const again = engine.activeRecord();
            if (again && again.id === rec.id) await this.tryComplete(slot, engine, again);
          });
        await this.broadcastPending(slot);
        await this.rotateBroadcast(slot, engine);
      } catch (e) {
        this.g.log.error('hosting.recovery_failed', { slot: slot.slotId, error: errorText(e) });
      }
    }
  }

  private block(slot: SlotRecord, rec: HostedRecoveryRecord, reason: HostedWait['reason'], detail: string): void {
    const prev = this.waits.get(slot.slotId);
    const same = prev && prev.recoveryId === rec.id && prev.reason === reason;
    this.waits.set(slot.slotId, { recoveryId: rec.id, reason, detail, since: same ? prev!.since : this.g.clock.now() });
    if (!same) this.g.log.warn('hosting.recovery_waiting', { slot: slot.slotId, recoveryId: rec.id, reason });
  }

  private async tryComplete(slot: SlotRecord, engine: HostedEngine, rec: HostedRecoveryRecord): Promise<void> {
    const g = this.g;
    if (engine.locked) return this.block(slot, rec, 'locked', 'The guardian is locked. Unlock it so it can co-sign the recovery.');
    let mtp: number;
    let height: number;
    try {
      const tip = await g.chain.tip();
      mtp = tip.medianTimePast * 1000;
      height = tip.height;
    } catch (e) {
      return this.block(slot, rec, 'chain_unavailable', `Waiting for chain data (${errorText(e)}).`);
    }
    if (Math.min(g.clock.now(), mtp) < rec.readyAt) return this.block(slot, rec, 'chain_time', `The recovery delay ends ${formatWhen(rec.readyAt)}; waiting for the chain.`);
    if (height < engine.heightNeeded(rec)) return this.block(slot, rec, 'chain_time', `Waiting for block ${engine.heightNeeded(rec)} (the chain is at ${height}).`);
    let coverage: { ok: true } | { ok: false; reason: 'sweep_incomplete' | 'sweep_inputs_missing'; detail: string };
    try {
      coverage = await this.checkCoverage(engine, rec);
    } catch (e) {
      return this.block(slot, rec, 'chain_unavailable', `Could not check the coins (${errorText(e)}).`);
    }
    if (!coverage.ok) return this.block(slot, rec, coverage.reason, coverage.detail);
    const res = await engine.completeRecovery();
    if (!res.ok) return this.block(slot, rec, 'refused', hostedRefusalText(res.refusal));
    this.waits.delete(slot.slotId);
    const now = g.clock.now();
    await this.h.updateSlotFile(slot.slotId, (f) => {
      f.sweeps = [...f.sweeps.filter((s) => s.recoveryId !== rec.id), { recoveryId: rec.id, txid: res.txid, psbt: base64.encode(res.psbt), txHex: res.txHex, amountSats: Number(rec.amountSats), completedAt: now, attempts: 0 }];
    });
    await g.logEvent({ type: 'hosting_recovery', name: slot.name, recoveryId: rec.id, state: 'completed' });
    void this.h.alerts.run();
  }

  /** The sweep's inputs are unspent, and every unspent ledger coin is swept or abandoned. Spent ledger coins are pruned. */
  async checkCoverage(engine: HostedEngine, rec: HostedRecoveryRecord): Promise<{ ok: true } | { ok: false; reason: 'sweep_incomplete' | 'sweep_inputs_missing'; detail: string }> {
    const tx = parsePsbt(base64.decode(rec.sweepPsbt));
    const inputs = new Map<string, Uint8Array>();
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      inputs.set(`${hex.encode(inp.txid!)}:${inp.index}`, inp.witnessUtxo!.script);
    }
    const ledger = engine.ledger();
    const scripts = [...inputs.values(), ...ledger.map((l) => hex.decode(l.script))];
    const unspent = new Set((await this.g.chain.scriptUnspent(scripts)).map((u) => `${u.txid}:${u.vout}`));
    const gone = [...inputs.keys()].filter((o) => !unspent.has(o));
    if (gone.length)
      return { ok: false, reason: 'sweep_inputs_missing', detail: `The sweep spends coins that are no longer unspent (${gone.slice(0, 5).join(', ')}), so it cannot be broadcast.` };
    const abandoned = new Set(rec.abandon);
    const missed = ledger.filter((l) => unspent.has(`${l.txid}:${l.vout}`) && !inputs.has(`${l.txid}:${l.vout}`) && !abandoned.has(`${l.txid}:${l.vout}`));
    const spentLedger = ledger.filter((l) => !unspent.has(`${l.txid}:${l.vout}`) && !inputs.has(`${l.txid}:${l.vout}`)).map((l) => `${l.txid}:${l.vout}`);
    if (spentLedger.length) await engine.pruneLedger(spentLedger);
    if (missed.length) {
      const total = missed.reduce((s, l) => s + l.valueSats, 0n);
      return {
        ok: false,
        reason: 'sweep_incomplete',
        detail: `The sweep leaves ${missed.length} coin${missed.length === 1 ? '' : 's'} this guardian co-signed (${formatBtc(total)}) neither swept nor abandoned. Update the recovery to include them.`,
      };
    }
    return { ok: true };
  }

  private async broadcastPending(slot: SlotRecord): Promise<void> {
    for (const s of this.h.slotFile(slot.slotId).sweeps) {
      if (s.broadcastAt !== undefined) continue;
      let ok = false;
      let error: string | undefined;
      try {
        const r = await this.g.chain.broadcast(s.txHex);
        ok = r.txid === s.txid;
      } catch (e) {
        error = errorText(e);
        try {
          ok = await this.g.chain.hasTransaction(s.txid);
        } catch {
          /* keep the error */
        }
      }
      const now = this.g.clock.now();
      await this.h.updateSlotFile(slot.slotId, (f) => {
        const x = f.sweeps.find((y) => y.recoveryId === s.recoveryId);
        if (x) Object.assign(x, ok ? { broadcastAt: now, lastError: undefined, attempts: x.attempts + 1 } : { lastError: error, attempts: x.attempts + 1 });
      });
      if (ok) this.g.log.info('hosting.sweep_broadcast', { slot: slot.slotId, recoveryId: s.recoveryId });
    }
  }

  private async rotateBroadcast(slot: SlotRecord, engine: HostedEngine): Promise<void> {
    const active = engine.registration()?.walletId;
    if (!active) return;
    for (const rec of engine.records()) {
      if (rec.status !== 'completed' || rec.rotatedAt !== undefined || rec.walletId !== active) continue;
      if (this.h.slotFile(slot.slotId).sweeps.find((s) => s.recoveryId === rec.id)?.broadcastAt === undefined) continue;
      const res = await this.g.recoveryMutex.run(() => engine.rotateAfterSweep(rec.id));
      if (!res.ok) {
        this.g.log.error('hosting.rotation_refused', { slot: slot.slotId, reason: res.refusal.reason });
        return;
      }
      const stamp = this.g.stampNow();
      if (res.adopted) {
        await this.g.notifyPeer(res.adopted.appNostrPubkey, {
          type: 'wallet_adopted',
          walletId: res.adopted.walletId,
          previousWalletId: res.retiredWalletId,
          recoveryId: rec.id,
          hardwareConfirmRequired: !res.adopted.hardwareAuthConfirmed,
          ...stamp,
          message: 'The guardian now protects your recovered wallet. Confirm your hardware wallet in the app before changing rules.',
        });
      }
      if (res.previousPhone && res.previousPhone !== res.adopted?.appNostrPubkey)
        await this.g.notifyPeer(res.previousPhone, { type: 'wallet_retired', walletId: res.retiredWalletId, reason: 'recovered', ...(res.adopted ? { successorWalletId: res.adopted.walletId } : {}), ...stamp });
      return;
    }
  }
}
