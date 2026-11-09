/**
 * Family hosting and the host's chain source (docs/design/family-hosting.md, "Chain sources and guests"): a guest
 * recovery's coin check (hosting/recovery.ts) works with every chain source, by the coins' own outpoints, and never
 * asks the chain source to watch the guest's wallet. With Bitcoin Core that means the host's watch-only wallet imports
 * no descriptor and no address of a guest (`prepare` is never called; coins are looked up with `gettxout`). The same
 * for phase 2's "leave" check (`Hosting.checkLedger`), which must not take a guest's ledger coins for spent on Core.
 */
import { base64, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import type { BackendUnspent, ChainBackend } from '../src/chain/backend.js';
import { ChainService } from '../src/chain/chain.js';
import { HostedRecoveryRunner } from '../src/hosting/recovery.js';
import type { HostedEngine } from '../src/hosting/engine.js';
import { Hosting } from '../src/hosting/service.js';
import type { Guardian } from '../src/guardian.js';
import type { HostedRecoveryRecord, LedgerEntry } from '../src/hosting/types.js';
import { classifyLedger } from '../src/hosting/ledger.js';
import { MNEMONICS, fundScript } from './helpers.js';
import { destinationAfterHardwareLoss, externalScript, hostedWallet, phoneSweep } from './support/hosted.js';

type Coin = { txid: string; vout: number; script: Uint8Array; value: bigint };
const tweaks = { app: '01', hardware: '02', cosigner: '03' };

/** A chain source that knows `utxos` and records what it is asked. `core`: by outpoint only, like `gettxout`. */
function stubBackend(kind: 'core' | 'electrum', utxos: Coin[], knownTx: string[] = []) {
  const calls = { prepare: 0, listUnspent: 0, unspentAt: 0, history: 0 };
  const match = (script: Uint8Array) => utxos.filter((u) => hex.encode(u.script) === hex.encode(script));
  const asUnspent = (u: Coin): BackendUnspent => ({ txid: u.txid, vout: u.vout, value: u.value, height: 90 });
  const backend: ChainBackend = {
    kind,
    connected: true,
    start() {},
    stop() {},
    onHeader: () => () => undefined,
    waitReady: async () => undefined,
    prepare: async () => {
      calls.prepare++;
      throw new Error('a guest wallet must never be imported');
    },
    history: async () => {
      calls.history++;
      return [];
    },
    // Bitcoin Core's `listunspent` reads its watch-only wallet, which holds nothing of a guest.
    listUnspent: async (script) => {
      calls.listUnspent++;
      return kind === 'core' ? [] : match(script).map(asUnspent);
    },
    ...(kind === 'core'
      ? {
          unspentAt: async (script: Uint8Array, outpoints: { txid: string; vout: number }[]) => {
            calls.unspentAt++;
            return match(script)
              .filter((u) => outpoints.some((o) => o.txid === u.txid && o.vout === u.vout))
              .map(asUnspent);
          },
        }
      : {}),
    transaction: async () => {
      throw new Error('not used');
    },
    hasTransaction: async (txid: string) => knownTx.includes(txid),
    headers: async () => '',
    estimateFee: async () => null,
    relayFee: async () => null,
    broadcast: async () => {
      throw new Error('not used');
    },
  };
  return { backend, calls };
}

async function guestRecovery() {
  const fx = await hostedWallet({ cosignerPub: hex.encode(secp256k1.getPublicKey(new Uint8Array(32).fill(5), true)) });
  const dest = await destinationAfterHardwareLoss(fx, MNEMONICS.hardware2);
  const swept = fundScript(fx.wallet.derive(0, 0).script, 200_000n, 0, 0);
  const psbt = await phoneSweep(fx, dest, [swept]);
  // A coin key 3 co-signed into existence (off path), still unspent, and one already spent (the coin its transaction
  // spent, `from`, is gone too: that transaction confirmed).
  const live = fundScript(externalScript(7), 50_000n);
  const spent = fundScript(externalScript(8), 40_000n);
  const ledger: LedgerEntry[] = [
    { txid: live.txid, vout: 0, valueSats: 50_000n, script: hex.encode(externalScript(7)), tweaks, at: 0, from: { txid: 'dd'.repeat(32), vout: 1, script: hex.encode(externalScript(9)) } },
    { txid: spent.txid, vout: 0, valueSats: 40_000n, script: hex.encode(externalScript(8)), tweaks, at: 0, from: { txid: 'dd'.repeat(32), vout: 0, script: hex.encode(externalScript(9)) } },
  ];
  const utxos: Coin[] = [
    { txid: swept.txid, vout: 0, script: fx.wallet.derive(0, 0).script, value: 200_000n },
    { txid: live.txid, vout: 0, script: externalScript(7), value: 50_000n },
    // Another coin on the same script as the live ledger coin: not asked for, not reported.
    { txid: 'ee'.repeat(32), vout: 3, script: externalScript(7), value: 1n },
  ];
  const rec = (abandon: string[]) => ({ sweepPsbt: base64.encode(psbt), abandon }) as unknown as HostedRecoveryRecord;
  return { ledger, utxos, rec, live, spent, swept };
}

function runnerOn(chain: ChainService, ledger: unknown[]) {
  const pruned: string[][] = [];
  const engine = { ledger: () => ledger, pruneLedger: async (s: string[]) => (pruned.push(s), s.length) } as unknown as HostedEngine;
  const runner = new HostedRecoveryRunner({ chain } as unknown as Guardian, {} as Hosting);
  return { runner, engine, pruned };
}

describe("family hosting on the host's chain source", () => {
  for (const kind of ['core', 'electrum'] as const) {
    it(`${kind}: a guest recovery's coin check works, and never asks the chain source to watch the guest's wallet`, async () => {
      const g = await guestRecovery();
      const { backend, calls } = stubBackend(kind, g.utxos);
      const chain = new ChainService({ backend });
      const { runner, engine, pruned } = runnerOn(chain, g.ledger);

      // The live ledger coin is neither swept nor abandoned: blocked.
      const blocked = await runner.checkCoverage(engine, g.rec([]));
      expect(blocked).toMatchObject({ ok: false, reason: 'sweep_incomplete' });
      // The spent ledger coin is pruned.
      expect(pruned).toEqual([[`${g.spent.txid}:0`]]);

      // Abandoned on purpose: complete.
      expect(await runner.checkCoverage(engine, g.rec([`${g.live.txid}:0`]))).toEqual({ ok: true });

      expect(calls.prepare).toBe(0);
      expect(calls.history).toBe(0);
      if (kind === 'core') {
        // Bitcoin Core: by outpoint (gettxout), the watch-only wallet is never read for a guest's coins.
        expect(calls.unspentAt).toBeGreaterThan(0);
        expect(calls.listUnspent).toBe(0);
      } else {
        expect(calls.listUnspent).toBeGreaterThan(0);
      }
    });
  }

  it('core: a swept coin that is gone blocks the recovery, as with Electrum', async () => {
    const g = await guestRecovery();
    const { backend } = stubBackend('core', g.utxos.filter((u) => u.txid !== g.swept.txid));
    const { runner, engine } = runnerOn(new ChainService({ backend }), g.ledger);
    expect(await runner.checkCoverage(engine, g.rec([`${g.live.txid}:0`]))).toMatchObject({ ok: false, reason: 'sweep_inputs_missing' });
  });

  it('outpointsUnspent reports only the outpoints asked for, one lookup per script', async () => {
    const g = await guestRecovery();
    const { backend, calls } = stubBackend('core', g.utxos);
    const chain = new ChainService({ backend });
    const res = await chain.outpointsUnspent([
      { txid: g.live.txid, vout: 0, script: externalScript(7) },
      { txid: g.live.txid, vout: 0, script: externalScript(7) },
      { txid: g.spent.txid, vout: 0, script: externalScript(8) },
    ]);
    expect([...res]).toEqual([`${g.live.txid}:0`]);
    expect(calls.unspentAt).toBe(2);
  });

  for (const kind of ['core', 'electrum'] as const) {
    it(`${kind}: leaving counts the unspent ledger coins by outpoint, and prunes only the spent one`, async () => {
      const g = await guestRecovery();
      const { backend, calls } = stubBackend(kind, g.utxos);
      const { engine, pruned } = runnerOn(new ChainService({ backend }), g.ledger);
      const fake = Object.assign(Object.create(Hosting.prototype), { g: { chain: new ChainService({ backend }) } }) as Hosting;
      expect(await fake.settleLedger(engine)).toEqual({ coins: 1, sats: 50_000n });
      expect(pruned).toEqual([[`${g.spent.txid}:0`]]);
      expect(calls.prepare).toBe(0);
      if (kind === 'core') expect(calls.listUnspent).toBe(0);
    });
  }

  for (const kind of ['core', 'electrum'] as const) {
    it(`${kind}: a coin not on the chain is kept while its transaction could still be broadcast (security sweep 3)`, async () => {
      const g = await guestRecovery();
      // A co-signed payment never broadcast: it spends the live coin (still unspent) into an output the chain never saw.
      const pending: LedgerEntry = { txid: 'ab'.repeat(32), vout: 1, valueSats: 49_000n, script: hex.encode(externalScript(10)), tweaks, at: 0, from: { txid: g.live.txid, vout: 0, script: hex.encode(externalScript(7)) } };
      // And one spending that never-broadcast output: it could only appear after it, so it waits on it.
      const next: LedgerEntry = { txid: 'cd'.repeat(32), vout: 0, valueSats: 48_000n, script: hex.encode(externalScript(11)), tweaks, at: 0, from: { txid: pending.txid, vout: 1, script: pending.script } };
      const { backend } = stubBackend(kind, g.utxos);
      const { engine, pruned } = runnerOn(new ChainService({ backend }), [...g.ledger, pending, next]);
      const fake = Object.assign(Object.create(Hosting.prototype), { g: { chain: new ChainService({ backend }) } }) as Hosting;
      expect(await fake.settleLedger(engine)).toEqual({ coins: 3, sats: 50_000n + 49_000n + 48_000n });
      expect(pruned).toEqual([[`${g.spent.txid}:0`]]);
      // The guest moves the live coin elsewhere: the payment can never confirm, and both settle.
      const { backend: after } = stubBackend(kind, g.utxos.filter((u) => u.txid !== g.live.txid));
      const check = await (Object.assign(Object.create(Hosting.prototype), { g: { chain: new ChainService({ backend: after }) } }) as Hosting).checkLedger([...g.ledger, pending, next]);
      expect(check.settled.sort()).toEqual([`${g.live.txid}:0`, `${g.spent.txid}:0`, `${pending.txid}:1`, `${next.txid}:0`].sort());
      expect(check.unknown).toEqual([]);
    });
  }

  it('a ledger entry from before `from` is settled only when the chain source knows its transaction', () => {
    const old: LedgerEntry = { txid: 'ef'.repeat(32), vout: 0, valueSats: 1_000n, script: '00', tweaks, at: 0 };
    expect(classifyLedger([old], new Set(), new Set())).toMatchObject({ settled: [], unknown: [old] });
    expect(classifyLedger([old], new Set(), new Set([old.txid]))).toMatchObject({ settled: [`${old.txid}:0`], unknown: [] });
    expect(classifyLedger([old], new Set([`${old.txid}:0`]), new Set([old.txid]))).toMatchObject({ unspent: [old], settled: [] });
  });
});
