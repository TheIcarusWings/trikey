/**
 * A wallet hosted on someone else's guardian (docs/design/family-hosting.md): what the guest is told before accepting
 * (section 9, word for word where the note fixes it), and where its chain data comes from (section 6): the guest's own
 * Esplora if they have one, else a public one through Recovery Key mode's `EsploraChainSource`, with a second public
 * server for the check before a recovery sweep (decision 4). Pure, so Node tests it.
 */
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { NETWORKS } from '@trikey/core';
import { DEFAULT_ESPLORA_URLS, EsploraChainSource, EsploraClient, PUBLIC_SERVER_PRIVACY_NOTE, type FetchLike } from '@trikey/recovery-key';
import type { ScriptUtxo, WalletDeps } from '@trikey/wallet';
import type { NetworkName } from './types';

/** A second public server per network, run by someone else than the default, for the check before a recovery sweep. */
export const SECOND_ESPLORA_URLS: Record<NetworkName, string> = {
  bitcoin: 'https://mempool.space/api',
  testnet: 'https://blockstream.info/testnet/api',
  signet: 'https://mempool.emzy.de/signet/api',
  regtest: 'http://127.0.0.1:3003',
};

/** The public server a hosted wallet uses without one of its own. */
export function publicServer(network: NetworkName): string {
  return DEFAULT_ESPLORA_URLS[network];
}

/** Recovery Key mode's chain source, plus the look-up by script a hosted wallet needs for the coins its guardian co-signed. */
class HostedEsploraSource extends EsploraChainSource {
  constructor(
    private readonly c: EsploraClient,
    wallet: ConstructorParameters<typeof EsploraChainSource>[1],
    private readonly network: NetworkName,
  ) {
    super(c, wallet);
  }

  async unspentByScript(scripts: string[]): Promise<ScriptUtxo[]> {
    const tip = await this.c.tipHeight();
    const out: ScriptUtxo[] = [];
    for (const script of scripts) {
      const address = btc.Address(NETWORKS[this.network].btc).encode(btc.OutScript.decode(hex.decode(script)));
      for (const u of await this.c.addressUtxos(address)) {
        const height = u.status.confirmed ? (u.status.block_height ?? 0) : 0;
        out.push({ script, txid: u.txid, vout: u.vout, valueSats: u.value, height, confirmations: height > 0 ? tip - height + 1 : 0 });
      }
    }
    return out;
  }
}

/** The wallet's `hostedChain`: the guest's server (or the public one) as primary, another public server as the check. */
export function hostedChainFactory(opts: { fetch?: FetchLike; second?: Partial<Record<NetworkName, string>> } = {}): NonNullable<WalletDeps['hostedChain']> {
  return ({ wallet, network, server, role }) => {
    const baseUrl = role === 'check' ? (opts.second?.[network] ?? SECOND_ESPLORA_URLS[network]) : (server ?? DEFAULT_ESPLORA_URLS[network]);
    return new HostedEsploraSource(new EsploraClient({ baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) }), wallet, network);
  };
}

export interface InviteDisclosure {
  title: string;
  cannotTitle: string;
  cannot: string[];
  trustingTitle: string;
  trusting: { text: string; strong?: true }[];
  changesTitle: string;
  changes: string[];
  checkbox: string;
  footer: string;
  /** Suggested on the accept screen (decision 7): the host as an alert contact, so they hear of a recovery too. */
  contactHint: string;
}

/**
 * Section 9's text for the invite screen. `host` is the name the invite shows, `device` the guest's hardware wallet
 * ("Ledger"), `server` where the app will read the balance (the guest's own server, or the public one).
 */
export function inviteDisclosure(p: { host: string; device: string; server: string; ownServer: boolean }): InviteDisclosure {
  const { host, device, server } = p;
  return {
    title: `${host} invites you to use their guardian`,
    cannotTitle: `What ${host} can't do`,
    cannot: [
      'Spend your money alone. Their box holds one of your three keys.',
      `Lock you out. Your phone and your ${device} can always move your money without them.`,
      'See your addresses or your balance. Their box does see each payment it co-signs (the amount and who you pay) and, if you ever recover your wallet, the total.',
    ],
    trustingTitle: "What you're trusting them with",
    trusting: [
      { text: 'Keeping the box online, and unlocking it after every restart, so payments with your phone alone work.' },
      {
        text: `Running the recovery wait and the alerts honestly. If ${host}, or someone who gets into their box, teams up with someone who has your phone or your ${device}, they can skip the daily limit and the wait, and keep the alerts silent: that person could take everything at once. Your alert contacts would not hear of it either.`,
        strong: true,
      },
      { text: 'Telling you before they stop hosting.' },
    ],
    changesTitle: 'What else changes',
    changes: [
      `Your app reads your balance from ${server}. It sees all your addresses and your IP address, but cannot move your money.${p.ownServer ? '' : ' (Use your own server in Settings if you have one.)'}`,
      'You must keep a backup of your phone key. A hosted wallet needs it to recover in every case.',
    ],
    checkbox: `I understand ${host} could help a thief skip the wait.`,
    footer: 'You can move to your own guardian any time.',
    contactHint: `Add ${host} as an alert contact too: then they hear of a recovery of your wallet, and can call you to ask "was that you?".`,
  };
}

/** The privacy note of the public server, as Recovery Key mode shows it. */
export const HOSTED_SERVER_NOTE = PUBLIC_SERVER_PRIVACY_NOTE;
