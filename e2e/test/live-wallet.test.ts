/**
 * The live wallet on a real chain (apps/guardian/src/live-wallet.ts): the guardian subscribes to the wallet's scripts on
 * the real Electrs (or polls Bitcoin Core's watch-only wallet), and the phone hears of a payment from another device
 * (the funding wallet in the node) within seconds, without asking: `wallet_tx` while it is in the mempool, again when
 * it confirms. `wallet.sync` is served from the subscriptions; how much faster than a scan is measured here against the
 * same Electrs.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Alert } from '@trikey/protocol';
import { TrikeyWallet, type WalletEvent } from '@trikey/wallet';
import { ChainService, ElectrumBackend, ElectrumClient } from '@trikey/guardian/chain';
import { HARDWARE_MNEMONICS, logGuardianOnFailure, newPhone, RULES, softwareDevice } from '../src/kit.js';
import { startRig, type E2eRig } from '../src/rig.js';
import { describeE2e, describeReal } from '../src/suite.js';
import { waitFor } from '../src/wait.js';

type WalletTx = Extract<Alert, { type: 'wallet_tx' }>;

function liveSuite(chainSource: 'electrum' | 'core') {
  let rig: E2eRig;
  let A: TrikeyWallet;
  const alerts: { alert: WalletTx; atMs: number }[] = [];
  const txAlert = (txid: string, confirmed: boolean) => alerts.find((a) => a.alert.txid === txid && a.alert.confirmations > 0 === confirmed);

  logGuardianOnFailure(() => rig);

  beforeAll(async () => {
    rig = await startRig(chainSource === 'core' ? { chainSource: 'core' } : {});
    const phone = newPhone(rig, softwareDevice(HARDWARE_MNEMONICS.one));
    A = await TrikeyWallet.create(phone.deps, { deviceName: `Live phone (${chainSource})` });
    A.on((e: WalletEvent) => {
      if (e.type === 'alert' && e.alert.type === 'wallet_tx') alerts.push({ alert: e.alert, atMs: Date.now() });
    });
    await A.onboard({ pairingUri: rig.pairingUri(), rules: RULES });
    // Bitcoin Core imports the wallet's descriptors first (a rescan on regtest: moments).
    await waitFor(() => rig.guardian.live!.store.state.wallets[A.state.wallet!.walletId], 'the guardian to read the new wallet', { timeoutMs: 60_000, intervalMs: 100 });
  });

  afterAll(async () => {
    await A?.close().catch(() => undefined);
    await rig?.stop();
  });

  it('lists live_wallet', async () => {
    await A.refreshStatus();
    expect(A.state.guardianStatus?.features).toContain('live_wallet');
  });

  it('a payment from another device reaches the phone within seconds, pending, then confirmed, without a sync', async () => {
    const syncedAt = A.state.chain?.syncedAt;
    const started = Date.now();
    const coin = await rig.fund(A.multisig().derive(0, 0).script, 120_000n);
    const pending = await waitFor(() => txAlert(coin.txid, false), 'wallet_tx for the payment in the mempool', { timeoutMs: 30_000, intervalMs: 20 });
    const pendingMs = pending.atMs - started;
    expect(pending.alert).toMatchObject({ direction: 'in', amountSats: 120_000, confirmations: 0, wallet: 'main' });
    // On the phone at once: listed, pending, in the balance, before any sync.
    expect(A.state.chain?.syncedAt).toBe(syncedAt);
    expect(A.snapshot()?.history.find((h) => h.txid === coin.txid) ?? A.state.liveTxs.find((t) => t.txid === coin.txid)).toBeTruthy();

    const mined = Date.now();
    await rig.mine(1);
    const confirmed = await waitFor(() => txAlert(coin.txid, true), 'wallet_tx for its confirmation', { timeoutMs: 30_000, intervalMs: 20 });
    const confirmMs = confirmed.atMs - mined;
    expect(confirmed.alert.confirmations).toBe(1);
    console.log(`\n[${chainSource}] payment from another device to the phone: ${pendingMs} ms (mempool), confirmation ${confirmMs} ms after mining`);
    expect(pendingMs).toBeLessThan(rig.kind === 'regtest' ? 15_000 : 5_000);

    const snap = await A.sync();
    expect(snap.history.filter((h) => h.txid === coin.txid)).toHaveLength(1);
    expect(snap.history.find((h) => h.txid === coin.txid)).toMatchObject({ confirmations: 1, netSats: 120_000 });
    expect(snap.balance.confirmedSats).toBe(120_000);
    await rig.mine(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(alerts.filter((a) => a.alert.txid === coin.txid)).toHaveLength(2);
  });

  if (chainSource === 'electrum')
    it('serves wallet.sync from the subscriptions: measured against a scan on the same Electrs', async () => {
      const e = rig.guardian.config.electrum!;
      const plain = new ChainService({ backend: new ElectrumBackend(new ElectrumClient({ host: e.host, port: e.port, pingIntervalMs: 0 })) });
      plain.start();
      try {
        await plain.backend!.waitReady(10_000);
        const wallet = A.multisig();
        // Transactions and block times cached on both sides first: only the script reads differ.
        await plain.walletSync(wallet);
        await rig.guardian.chain.walletSync(wallet);
        const runs = 5;
        let scan = 0;
        let cached = 0;
        for (let i = 0; i < runs; i++) {
          let t = performance.now();
          const a = await plain.walletSync(wallet);
          scan += performance.now() - t;
          t = performance.now();
          const b = await rig.guardian.chain.walletSync(wallet);
          cached += performance.now() - t;
          expect(b.confirmedSats).toBe(a.confirmedSats);
          expect(b.utxos.map((u) => `${u.txid}:${u.vout}`)).toEqual(a.utxos.map((u) => `${u.txid}:${u.vout}`));
        }
        const stats = rig.guardian.chain.liveStats();
        console.log(`\n[electrum, ${rig.kind}] wallet.sync, mean of ${runs}: scan ${(scan / runs).toFixed(1)} ms, from subscriptions ${(cached / runs).toFixed(1)} ms (${JSON.stringify(stats)})`);
        expect(stats).toMatchObject({ kind: 'electrum', limited: false });
        expect(cached).toBeLessThan(scan);
      } finally {
        plain.stop();
      }
    });
}

describeE2e('the live wallet, Electrum (subscriptions)', () => liveSuite('electrum'));
describeReal('the live wallet, Bitcoin Core alone (its wallet polled)', () => liveSuite('core'));
