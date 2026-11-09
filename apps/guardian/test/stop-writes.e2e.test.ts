/**
 * `Guardian.stop()` resolves only once the guardian has stopped writing to its data directory.
 *
 * Work it sets off in the background used to go on after it: an alert pass started when a Savings spend is announced
 * (it records what it sent in guardian-state.json), and the save of a relayed transaction (relayed-txs.json). On a
 * shutdown such a write could be cut short, or land after the process was told it had stopped; in tests the removal of
 * the rig's temp folder raced it (`ENOTEMPTY: directory not empty, rmdir` in mempool-blind and savings-flood on CI).
 * Regtest, throwaway keys and published test mnemonics only.
 */
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MultisigWallet, RECEIVE, SAVINGS_ACCOUNT, SoftwareSigner, buildSpend, combinePsbts, finalizePsbt } from '@trikey/core';
import { GuardianRig } from './support/index.js';
import { appSigner, externalAddress, hwSigner, network } from './helpers.js';
import { pairInRig } from './security/support.js';
import type { Mutex } from '../src/files.js';
import { RELAYED_FILE } from '../src/chain/relayed.js';

const RECOVERY_KEY = new SoftwareSigner('cosigner', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', 'second hardware wallet');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every change to `dir` (recursively) during `ms`. */
async function writesDuring(dir: string, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const w = watch(dir, { recursive: true }, (event, file) => seen.push(`${event} ${file}`));
  await sleep(ms);
  w.close();
  return seen;
}

/** A watched, baselined Savings wallet with one coin, and a spend of it by the hardware wallet and the Recovery Key. */
async function savingsSpend(rig: GuardianRig): Promise<{ txHex: string; txid: string }> {
  const g = rig.guardian;
  await pairInRig(rig);
  const savings = new MultisigWallet(network, {
    app: await appSigner().getKey(network, SAVINGS_ACCOUNT),
    hardware: await hwSigner().getKey(network, SAVINGS_ACCOUNT),
    cosigner: await RECOVERY_KEY.getKey(network, SAVINGS_ACCOUNT),
  });
  const reg = await g.engine.registerSavings(savings.descriptor());
  if (!reg.ok) throw new Error(JSON.stringify(reg.refusal));
  const coin = rig.fund(savings.derive(RECEIVE, 0).script, 400_000n);
  await g.savingsWatch.run({ force: true });
  expect(g.engine.savings()?.baselined).toBe(true);
  const plan = buildSpend({ wallet: savings, utxos: [{ txid: coin.txid, vout: 0, value: 400_000n, chain: 0, index: 0, prevTxHex: coin.rawTx }], recipients: [{ address: externalAddress(9), amount: 100_000n }], feeRate: 2, changeIndex: 0 });
  return finalizePsbt(combinePsbts([await hwSigner().signPsbt(plan.psbt, network), await RECOVERY_KEY.signPsbt(plan.psbt, network)]));
}

describe('stopping the guardian', { timeout: 60_000 }, () => {
  let rig: GuardianRig;
  afterEach(async () => rig?.stop());

  it('waits for the alert pass a Savings spend set off: the contacts are told, nothing is sent or written after', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    const { txHex, txid } = await savingsSpend(rig);
    // Slow relays, so the alert pass is still under way when stop() is called.
    let stopped = false;
    const lateSends: string[] = [];
    const dm = g.dm!;
    const send = dm.send.bind(dm);
    dm.send = async (to, text) => {
      await sleep(500);
      if (stopped) lateSends.push(to);
      return send(to, text);
    };
    // The spend reaches the server; the tripwire announces it, and the alert pass runs in the background.
    expect(rig.electrs.applyTransaction(txHex)).toBeUndefined();
    await g.savingsWatch.run({ force: true });
    expect(g.engine.activity({ limit: 100 }).find((e) => e.type === 'savings_moved')).toMatchObject({ txid });

    await g.stop();
    stopped = true;
    expect(await writesDuring(rig.dir, 1500)).toEqual([]);
    expect(lateSends).toEqual([]);
    expect(g.engine.dueNotices().filter((n) => n.kind === 'savings_moved')).toEqual([]);
  });

  it('waits for the save of a transaction it relayed: the record is on disk, nothing is written after', async () => {
    rig = await GuardianRig.start();
    const g = rig.guardian;
    const { txHex, txid } = await savingsSpend(rig);
    // A slow disk (a Raspberry Pi's SD card): the record's save waits behind another write.
    void (g.chain.relayed as unknown as { mutex: Mutex }).mutex.run(() => sleep(500));
    expect((await g.chain.broadcast(txHex, { track: true })).txid).toBe(txid);

    await g.stop();
    expect(await writesDuring(rig.dir, 1500)).toEqual([]);
    expect(JSON.parse(await readFile(join(rig.dir, RELAYED_FILE), 'utf8')).txs.map((t: { txid: string }) => t.txid)).toEqual([txid]);
  });
});
