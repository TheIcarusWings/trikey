/**
 * A wallet hosted on someone else's guardian, in the app (docs/design/family-hosting.md): the invite screen's words
 * (section 9: the dishonest-host sentence, the public server, the required phone key backup, the checkbox), the chain
 * source the app gives the wallet (the guest's server or a public Esplora, a second server for the check), the demo's
 * flow, and the real service against the real guardian (the rig) with the guest's chain from the rig's own chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { HDKey } from '@scure/bip32';
import { MultisigWallet, NETWORKS, keyExpressionFromMaster } from '@trikey/core';
import { encodeInviteUri, generatePairingSecret } from '@trikey/protocol';
import { GuardianRig, type FakeElectrum } from '@trikey/guardian/testing';
import type { ChainSnapshot, ChainSource, WalletDeps } from '@trikey/wallet';
import { MemoryCloudBackupStore, MemoryKeyValueStore, MemoryPasskeyPrf, MemorySecureKeyStore, SoftwareHardwareProvider, SoftwareHardwareSigner } from '@trikey/wallet/testing';
import { createMockWalletService } from './mock';
import { SECOND_ESPLORA_URLS, hostedChainFactory, inviteDisclosure, publicServer } from './hosted';
import { createRealWalletService, type RealWalletService } from './real';

describe('the invite screen says what section 9 says', () => {
  const d = inviteDisclosure({ host: 'Maria', device: 'Ledger', server: 'mempool.space', ownServer: false });

  it('a dishonest host with a thief could skip the limit and the wait, and keep the alerts silent', () => {
    expect(d.title).toBe('Maria invites you to use their guardian');
    const strong = d.trusting.find((t) => t.strong)!.text;
    expect(strong).toMatch(/If Maria, or someone who gets into their box, teams up with someone who has your phone or your Ledger, they can skip the daily limit and the wait, and keep the alerts silent/);
    expect(strong).toMatch(/Your alert contacts would not hear of it either/);
    expect(d.checkbox).toBe('I understand Maria could help a thief skip the wait.');
  });

  it('does not overstate privacy: the box sees each co-signed payment and a recovery total', () => {
    const see = d.cannot.find((l) => l.startsWith('See your addresses'))!;
    expect(see).toMatch(/Their box does see each payment it co-signs \(the amount and who you pay\)/);
    expect(see).toMatch(/the total/);
    expect(d.cannot.join(' ')).not.toMatch(/Raise your daily limit/);
  });

  it('names the chain server (which sees every address) and requires the phone key backup; suggests the host as a contact', () => {
    expect(d.changes[0]).toMatch(/reads your balance from mempool.space\. It sees all your addresses and your IP address/);
    expect(d.changes[0]).toMatch(/Use your own server in Settings/);
    expect(d.changes[1]).toMatch(/You must keep a backup of your phone key/);
    expect(d.contactHint).toMatch(/Add Maria as an alert contact/);
  });
});

describe("the hosted wallet's chain source", () => {
  it("uses the guest's server, else the public one; the check asks another public server", async () => {
    const asked: string[] = [];
    const fetchFn = async (url: string) => {
      asked.push(url);
      if (url.endsWith('/blocks/tip/height')) return { status: 200, text: async () => '100' };
      if (url.includes('/address/')) return { status: 200, text: async () => JSON.stringify([{ txid: 'ab'.repeat(32), vout: 1, value: 5000, status: { confirmed: true, block_height: 91 } }]) };
      return { status: 404, text: async () => '' };
    };
    const factory = hostedChainFactory({ fetch: fetchFn as never });
    const m = (b: number) => HDKey.fromMasterSeed(new Uint8Array(32).fill(b), NETWORKS.signet.bip32);
    const wallet = new MultisigWallet(NETWORKS.signet, {
      app: keyExpressionFromMaster(m(1), "m/48'/1'/0'/2'"),
      hardware: keyExpressionFromMaster(m(2), "m/48'/1'/0'/2'"),
      cosigner: keyExpressionFromMaster(m(3), "m/48'/1'/0'/2'"),
    });
    const own = factory({ wallet, network: 'signet', server: 'https://my.server/api', role: 'primary' })!;
    const pub = factory({ wallet, network: 'signet', role: 'primary' })!;
    const check = factory({ wallet, network: 'signet', role: 'check' })!;
    const script = hex.encode(wallet.derive(0, 0).script);
    const got = await own.unspentByScript!([script]);
    expect(got).toEqual([{ script, txid: 'ab'.repeat(32), vout: 1, valueSats: 5000, height: 91, confirmations: 10 }]);
    await pub.unspentByScript!([script]);
    await check.unspentByScript!([script]);
    expect(asked.some((u) => u.startsWith('https://my.server/api/address/'))).toBe(true);
    expect(asked.some((u) => u.startsWith(`${publicServer('signet')}/address/`))).toBe(true);
    expect(asked.some((u) => u.startsWith(`${SECOND_ESPLORA_URLS.signet}/address/`))).toBe(true);
    expect(SECOND_ESPLORA_URLS.signet).not.toBe(publicServer('signet'));
    expect(SECOND_ESPLORA_URLS.bitcoin).not.toBe(publicServer('bitcoin'));
  });
});

describe('the demo', () => {
  it('reads an invite, needs the checkbox, then the wallet is hosted (with a chain server setting)', async () => {
    const svc = createMockWalletService();
    const inv = svc.readInvite!('demo-invite');
    expect(inv).toMatchObject({ hostLabel: "Maria's Umbrel", acknowledged: false });
    await expect(svc.setUpRules(100_000, 7)).rejects.toMatchObject({ kind: 'wrong_state' });
    svc.acknowledgeInvite!(true);
    expect(svc.getState().invite?.acknowledged).toBe(true);
    await svc.setUpRules(100_000, 7);
    expect(svc.getState().invite).toBeUndefined();
    expect(svc.getState().hosted).toMatchObject({ hostLabel: "Maria's Umbrel", chainServer: null });
    await svc.setHostedChainServer!('https://my.server/api');
    expect(svc.getState().hosted?.chainServer).toBe('https://my.server/api');
    expect(svc.readCode('demo-invite')).toMatchObject({ kind: 'invite' });
  });
});

/** The guest's chain server over the rig's fake Electrs (the regtest stack has no Esplora). */
class RigChain implements ChainSource {
  readonly kind = 'esplora';
  constructor(
    private readonly e: FakeElectrum,
    private readonly wallet: MultisigWallet,
  ) {}
  private sh(script: Uint8Array) {
    return hex.encode(sha256(script).reverse());
  }
  async sync(): Promise<ChainSnapshot> {
    const utxos: ChainSnapshot['utxos'] = [];
    const next: number[] = [];
    for (const chain of [0, 1] as const) {
      let gap = 0;
      let first = -1;
      for (let index = 0; gap < 20; index++) {
        const sh = this.sh(this.wallet.derive(chain, index).script);
        if (!(this.e.history.get(sh) ?? []).length) {
          gap++;
          if (first < 0) first = index;
          continue;
        }
        gap = 0;
        first = -1;
        for (const u of this.e.unspent.get(sh) ?? []) utxos.push({ txid: u.txid, vout: u.vout, valueSats: u.value, height: Math.max(0, u.height), confirmations: u.height > 0 ? this.e.height - u.height + 1 : 0, chain, index });
      }
      next.push(first);
    }
    const total = utxos.reduce((a, u) => a + u.valueSats, 0);
    return { tipHeight: this.e.height, tipHash: '00'.repeat(32), utxos, utxosTruncated: false, balance: { confirmedSats: total, unconfirmedSats: 0 }, history: [], historyTruncated: false, nextReceiveIndex: next[0]!, nextChangeIndex: next[1]!, gapLimit: 20 };
  }
  async getTransaction(txid: string) {
    const raw = this.e.txs.get(txid)!;
    const tx = btc.RawTx.decode(hex.decode(raw));
    return hex.encode(btc.RawTx.encode({ ...tx, segwitFlag: false, witnesses: undefined }));
  }
  async broadcast(txHex: string) {
    const err = this.e.applyTransaction(txHex);
    if (err) throw new Error(err);
    return btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true }).id;
  }
  async estimateFees() {
    return { estimates: [{ target: 3, satPerVb: 3 }, { target: 6, satPerVb: 2 }], minRelaySatPerVb: 1 };
  }
}

describe('the real service with a real guardian as host', () => {
  let rig: GuardianRig;
  const opened: RealWalletService[] = [];
  beforeAll(async () => {
    rig = await GuardianRig.start({ http: true });
  }, 30_000);
  afterAll(async () => {
    for (const s of opened) await s.close();
    await rig?.stop();
  });

  async function service(): Promise<RealWalletService> {
    const hostedChain: WalletDeps['hostedChain'] = ({ wallet }) => new RigChain(rig.electrs, wallet);
    const svc = await createRealWalletService({
      mode: 'simulator',
      network: 'regtest',
      platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: new MemoryPasskeyPrf() },
      hardware: () => [new SoftwareHardwareProvider(new SoftwareHardwareSigner({ mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', network: 'regtest', kind: 'ledger' }))],
      clock: rig.clock,
      rpcTimeoutMs: 5000,
      rpcRetryIntervalMs: 0,
      syncIntervalMs: 0,
      yieldToUi: async () => {},
      recoveryCodeKdf: { m: 64, t: 1, p: 1 },
      hostedChain,
    });
    opened.push(svc);
    return svc;
  }

  it('accepts an invite only after the checkbox; the wallet is hosted, and the guardian keeps only its account pubkeys', async () => {
    const link = (await rig.api('POST', '/hosting/invites', { name: 'Ana' })).body.link as string;
    const svc = await service();
    await svc.connectHardware('ledger');
    expect(svc.readCode(link)).toMatchObject({ kind: 'invite' });
    const inv = svc.readInvite!(link);
    expect(inv).toMatchObject({ hostLabel: 'Trikey Guardian', network: 'regtest', acknowledged: false });
    expect(svc.getState().invite).toBeTruthy();
    await expect(svc.setUpRules(100_000, 7)).rejects.toMatchObject({ kind: 'wrong_state' });
    svc.acknowledgeInvite!(true);
    await svc.setUpRules(100_000, 7);
    const s = svc.getState();
    expect(s.invite).toBeUndefined();
    expect(s.hosted).toMatchObject({ hostLabel: 'Trikey Guardian', chainServer: null });
    expect(svc.wallet!.isHosted).toBe(true);
    const slot = rig.guardian.hosting.registry.slots.find((x) => x.name === 'Ana')!;
    expect(rig.guardian.hosting.engines.get(slot.slotId)!.registration()!.walletId).toBe(svc.wallet!.state.wallet!.walletId);
  });

  it('on mainnet an invite needs the same pre-alpha consent as guardian mode, before anything else', async () => {
    const svc = await createRealWalletService({
      mode: 'real',
      platform: { os: 'ios', isSecure: true, secureKeys: new MemorySecureKeyStore(), kv: new MemoryKeyValueStore(), cloudBackups: [new MemoryCloudBackupStore()], passkeys: new MemoryPasskeyPrf() },
      hardware: () => [],
      clock: rig.clock,
      syncIntervalMs: 0,
      yieldToUi: async () => {},
    });
    opened.push(svc);
    svc.setNetwork('bitcoin');
    const now = Math.floor(rig.clock.now() / 1000);
    const link = encodeInviteUri({ guardianPubkey: rig.pubkey, relays: ['wss://relay.example.com'], secret: generatePairingSecret(), expiresAt: now + 3600, network: 'bitcoin', label: 'Maria' }, now);
    expect(() => svc.readInvite!(link)).toThrow(/mainnet warning/);
    svc.acceptMainnetRisk(true);
    expect(svc.readInvite!(link)).toMatchObject({ mainnet: true, hostLabel: 'Maria' });
  });
});
