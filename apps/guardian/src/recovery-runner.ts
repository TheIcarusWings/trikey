/**
 * Completes a Delay & Notify recovery once its delay is over, and broadcasts
 * the sweep. Before asking the engine to co-sign (`completeRecovery`):
 *
 * 1. Time, three ways. `readyAt` counts from the later of the system clock and
 *    the chain's median time past at the start (engine). At completion the
 *    system clock AND the median time past of the latest block (from Electrs)
 *    must both be past `readyAt`, and the chain must have grown by the delay's
 *    blocks since the start (`PolicyEngine.heightNeeded`): a clock pushed
 *    forward, or set back at the start, cannot shorten the delay (DESIGN.md,
 *    threat model). If clock and chain differ by more than 2 hours we log a
 *    warning. The engine checks all three again.
 * 2. Coverage. The sweep must spend every unspent output of the wallet's
 *    derived addresses (receive and change chains, gap limit 20, extended to
 *    the indexes the sweep itself uses), and nothing that is no longer
 *    unspent. Otherwise funds would be left behind in a wallet whose phone key
 *    the guardian retires, or the sweep would be invalid.
 *
 * Then it stores the co-signed sweep, broadcasts it through Electrs (Bitcoin
 * Core as a fallback), records the txid, and retries the broadcast on later
 * ticks until it goes through.
 *
 * Once a node has accepted the sweep, the guardian rotates wallets
 * (`Guardian.rotateAfterSweep`): the swept wallet is retired and the
 * destination adopted when it keeps this guardian's key. This also runs on
 * every tick for a broadcast sweep whose rotation did not happen yet (a crash
 * between the two, or a state migrated from before wallet rotation).
 */
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base64, hex } from '@scure/base';
import { MultisigWallet, analyzePsbt, finalizePsbt, getNetwork, parsePsbt, sighashAll } from '@trikey/core';
import type { Guardian } from './guardian.js';
import { errorText } from './log.js';
import { HOUR, MAX_SELF_INDEX, type RecoveryRecord, type Registration } from './policy/index.js';
import { refusalText } from './nostr/wire.js';
import type { SweepRecord } from './service-state.js';
import { formatBtc, formatWhen } from './alerts.js';

export const MAX_CLOCK_DISAGREEMENT_MS = 2 * HOUR;

export type WaitReason = 'locked' | 'chain_unavailable' | 'chain_time' | 'sweep_incomplete' | 'sweep_inputs_missing' | 'refused' | 'error';

export interface RecoveryWait {
  recoveryId: string;
  reason: WaitReason;
  /** Plain-language explanation for the web UI and the activity log. */
  detail: string;
  since: number;
}

type CoverageResult = { ok: true } | { ok: false; reason: 'sweep_incomplete' | 'sweep_inputs_missing'; detail: string };

/** Outpoints and the highest derivation index per chain of a PSBT's inputs. */
function sweepInputs(psbt: Uint8Array): { outpoints: Set<string>; maxIndex: Partial<Record<0 | 1, number>> } {
  const tx = parsePsbt(psbt);
  const outpoints = new Set<string>();
  const maxIndex: Partial<Record<0 | 1, number>> = {};
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    outpoints.add(`${hex.encode(inp.txid!)}:${inp.index}`);
    for (const [, { path }] of inp.bip32Derivation ?? []) {
      if (path.length < 2) continue;
      const chain = path[path.length - 2];
      const index = path[path.length - 1];
      if ((chain === 0 || chain === 1) && index >= 0 && index <= MAX_SELF_INDEX) maxIndex[chain] = Math.max(maxIndex[chain] ?? -1, index);
    }
  }
  return { outpoints, maxIndex };
}

export class RecoveryRunner {
  /** Why the running recovery has not completed yet, if its delay is over. */
  wait?: RecoveryWait;
  private lastSkewWarning?: string;

  constructor(private readonly g: Guardian) {}

  async run(): Promise<void> {
    const g = this.g;
    const rec = g.activeRecord();
    if (!rec || g.clock.now() < rec.readyAt) {
      this.wait = undefined;
    } else {
      await g.recoveryMutex.run(async () => {
        const again = g.activeRecord();
        if (again && again.id === rec.id) await this.tryComplete(again);
      });
    }
    await this.recreateMissingSweeps();
    await this.broadcastPending();
    await this.rotateBroadcast();
  }

  /** Completed recoveries of the active wallet whose sweep a node accepted: rotate (once). */
  private async rotateBroadcast(): Promise<void> {
    const g = this.g;
    const active = g.engine.registration()?.walletId;
    if (!active) return;
    for (const rec of g.records) {
      if (rec.status !== 'completed' || rec.rotatedAt !== undefined || rec.walletId !== active) continue;
      if (g.service.sweep(rec.id)?.broadcastAt === undefined) continue;
      await g.recoveryMutex.run(() => g.rotateAfterSweep(rec.id));
      return; // the active wallet changed; anything else waits for the next tick
    }
  }

  private async block(rec: RecoveryRecord, reason: WaitReason, detail: string): Promise<void> {
    const same = this.wait && this.wait.recoveryId === rec.id && this.wait.reason === reason;
    this.wait = { recoveryId: rec.id, reason, detail, since: same ? this.wait!.since : this.g.clock.now() };
    if (!same) {
      this.g.log.warn('recovery.waiting', { recoveryId: rec.id, reason, detail });
      await this.g.logEvent({ type: 'recovery_waiting', recoveryId: rec.id, reason, detail });
    }
  }

  private async tryComplete(rec: RecoveryRecord): Promise<void> {
    const g = this.g;
    const reg = g.engine.registration();
    if (!reg) return;
    if (g.locked) return this.block(rec, 'locked', 'The guardian is locked. Unlock it so it can co-sign the recovery.');

    let mtp: number;
    let height: number;
    try {
      const tip = await g.chain.tip();
      mtp = tip.medianTimePast * 1000;
      height = tip.height;
    } catch (e) {
      return this.block(rec, 'chain_unavailable', `Waiting for chain data from Electrs (${errorText(e)}).`);
    }
    const now = g.clock.now();
    if (Math.abs(now - mtp) > MAX_CLOCK_DISAGREEMENT_MS) {
      const key = `${Math.floor(now / HOUR)}:${mtp}`;
      if (this.lastSkewWarning !== key) {
        this.lastSkewWarning = key;
        g.log.warn('clock.disagrees_with_chain', { systemTime: new Date(now).toISOString(), chainTime: new Date(mtp).toISOString() });
        await g.logEvent({ type: 'clock_skew', systemTime: now, chainTime: mtp });
      }
    }
    const effective = Math.min(now, mtp);
    if (effective < rec.readyAt)
      return this.block(
        rec,
        'chain_time',
        `The recovery delay ends ${formatWhen(rec.readyAt)}, but the chain's median time is ${formatWhen(mtp)}. Waiting for more blocks.`,
      );
    // The delay must span its blocks too (the engine checks this again).
    const needed = g.engine.heightNeeded(rec);
    if (needed !== undefined && height < needed)
      return this.block(rec, 'chain_time', `The recovery delay must also span ${needed - (rec.startHeight ?? 0)} blocks; the chain is at block ${height} of ${needed}. Waiting for more blocks.`);

    let coverage: CoverageResult;
    try {
      coverage = await this.checkCoverage(rec, reg);
    } catch (e) {
      return this.block(rec, 'chain_unavailable', `Could not check the wallet's coins (${errorText(e)}).`);
    }
    if (!coverage.ok) return this.block(rec, coverage.reason, coverage.detail);

    const res = await g.engine.completeRecovery();
    if (!res.ok) return this.block(rec, 'refused', refusalText(res.refusal));
    this.wait = undefined;
    const sweep: SweepRecord = {
      recoveryId: rec.id,
      txid: res.txid,
      psbt: base64.encode(res.psbt),
      txHex: res.txHex,
      amountSats: Number(rec.amountSats),
      completedAt: now,
      attempts: 0,
    };
    await g.service.update((d) => {
      d.sweeps = [...d.sweeps.filter((s) => s.recoveryId !== rec.id), sweep];
    });
    g.log.info('recovery.completed', { recoveryId: rec.id, txid: res.txid });
    void g.alerts.run();
  }

  /** Does the stored sweep spend exactly the wallet's unspent outputs? */
  async checkCoverage(rec: RecoveryRecord, reg: Registration): Promise<CoverageResult> {
    const wallet = MultisigWallet.fromDescriptor(reg.descriptor, getNetwork(reg.network));
    const { outpoints, maxIndex } = sweepInputs(base64.decode(rec.sweepPsbt));
    // At least to the wallet's high-water marks: every change output key 3 ever co-signed is in range.
    const floor = this.g.scanFloor(reg.walletId);
    const minIndex = { 0: Math.max(maxIndex[0] ?? -1, floor[0] ?? -1), 1: Math.max(maxIndex[1] ?? -1, floor[1] ?? -1) };
    const utxos = await this.g.chain.walletUtxos(wallet, { minIndex });
    const unspent = new Set(utxos.map((u) => `${u.txid}:${u.vout}`));
    const missed = utxos.filter((u) => !outpoints.has(`${u.txid}:${u.vout}`));
    if (missed.length) {
      const total = missed.reduce((s, u) => s + u.value, 0n);
      const list = missed.slice(0, 5).map((u) => `${u.txid}:${u.vout}`).join(', ');
      return {
        ok: false,
        reason: 'sweep_incomplete',
        detail:
          `The sweep leaves ${missed.length} coin${missed.length === 1 ? '' : 's'} (${formatBtc(total)}) in the wallet: ${list}${missed.length > 5 ? ', ...' : ''}. ` +
          'It must move every coin. Cancel this recovery and start a new one that spends them all.',
      };
    }
    const gone = [...outpoints].filter((o) => !unspent.has(o));
    if (gone.length)
      return {
        ok: false,
        reason: 'sweep_inputs_missing',
        detail: `The sweep spends coins that are no longer unspent (${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ', ...' : ''}), so it cannot be broadcast.`,
      };
    return { ok: true };
  }

  /**
   * If the process died between the engine completing a recovery and the
   * service saving the co-signed sweep, the signature is lost with it. The
   * engine has already decided (the record is `completed` at `sweepTxid`), so
   * re-create the signatures for exactly that stored sweep, once unlocked.
   */
  private async recreateMissingSweeps(): Promise<void> {
    const g = this.g;
    const signer = g.unlockedSigner;
    if (!signer) return;
    for (const rec of g.records) {
      if (rec.status !== 'completed' || g.service.sweep(rec.id)) continue;
      // The swept wallet: the active one, or a retired one after the rotation.
      const reg = g.engine.walletById(rec.walletId);
      if (!reg) continue;
      try {
        const net = getNetwork(reg.network);
        const wallet = MultisigWallet.fromDescriptor(reg.descriptor, net);
        const dest = MultisigWallet.fromDescriptor(rec.destinationDescriptor, net);
        const bytes = base64.decode(rec.sweepPsbt);
        const a = analyzePsbt(bytes, wallet.accountPubkeys(), net, { requireNonWitnessUtxo: true, outputsAcct: dest.accountPubkeys() });
        if (a.txid !== rec.sweepTxid || a.inputs.some((i) => i.signedBy.length !== 1 || i.signedBy[0] !== rec.survivingRole))
          throw new Error('stored sweep does not match the completed recovery');
        const tx = parsePsbt(bytes);
        for (const inp of a.inputs) {
          const msg = sighashAll(tx, inp.index, inp.witnessScript, inp.amount);
          const der = signer.sign(msg, inp.tweaks.cosigner);
          if (!secp256k1.verify(der, msg, inp.pubkeys.cosigner, { prehash: false, format: 'der', lowS: true })) throw new Error('bad signature');
          tx.updateInput(inp.index, { partialSig: [[inp.pubkeys.cosigner, Uint8Array.from([...der, btc.SigHash.ALL])]] }, true);
        }
        const psbt = tx.toPSBT();
        const { txHex, txid } = finalizePsbt(psbt);
        await g.service.update((d) => {
          d.sweeps.push({
            recoveryId: rec.id,
            txid,
            psbt: base64.encode(psbt),
            txHex,
            amountSats: Number(rec.amountSats),
            completedAt: rec.completedAt ?? g.clock.now(),
            attempts: 0,
          });
        });
        g.log.warn('recovery.sweep_recreated', { recoveryId: rec.id, txid });
      } catch (e) {
        g.log.error('recovery.sweep_recreate_failed', { recoveryId: rec.id, error: errorText(e) });
      }
    }
  }

  private async broadcastPending(): Promise<void> {
    const g = this.g;
    for (const s of g.service.get().sweeps) {
      if (s.broadcastAt !== undefined) continue;
      let via: 'electrum' | 'bitcoind' | undefined;
      let error: string | undefined;
      try {
        const r = await g.chain.broadcast(s.txHex);
        if (r.txid !== s.txid) throw new Error(`the server reported txid ${r.txid}`);
        via = r.via;
      } catch (e) {
        error = errorText(e);
        // Already in the mempool or a block (e.g. broadcast before a crash): that is a success.
        try {
          if (await g.chain.hasTransaction(s.txid)) {
            via = 'electrum';
            error = undefined;
          }
        } catch {
          /* keep the broadcast error */
        }
      }
      const now = g.clock.now();
      if (via) {
        await g.service.update((d) => {
          const x = d.sweeps.find((y) => y.recoveryId === s.recoveryId);
          if (x) Object.assign(x, { broadcastAt: now, broadcastVia: via, lastError: undefined, attempts: x.attempts + 1 });
        });
        await g.logEvent({ type: 'sweep_broadcast', recoveryId: s.recoveryId, txid: s.txid, via, amountSats: s.amountSats });
        g.log.info('recovery.sweep_broadcast', { recoveryId: s.recoveryId, txid: s.txid, via });
      } else {
        const changed = s.lastError !== error;
        await g.service.update((d) => {
          const x = d.sweeps.find((y) => y.recoveryId === s.recoveryId);
          if (x) Object.assign(x, { lastError: error, attempts: x.attempts + 1 });
        });
        if (changed) {
          await g.logEvent({ type: 'sweep_broadcast_failed', recoveryId: s.recoveryId, txid: s.txid, detail: error ?? 'unknown error' });
          g.log.warn('recovery.sweep_broadcast_failed', { recoveryId: s.recoveryId, txid: s.txid, error });
        }
      }
    }
  }
}
