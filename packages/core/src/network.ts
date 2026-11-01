import { NETWORK, TEST_NETWORK } from '@scure/btc-signer';

export type NetworkName = 'bitcoin' | 'testnet' | 'signet' | 'regtest';

type BtcNetwork = typeof NETWORK;

export interface Network {
  name: NetworkName;
  btc: BtcNetwork;
  /** BIP32 version bytes (xpub/tpub). */
  bip32: { public: number; private: number };
  /** BIP44 coin type used in BIP48 paths. */
  coinType: 0 | 1;
}

const MAINNET_BIP32 = { public: 0x0488b21e, private: 0x0488ade4 };
const TESTNET_BIP32 = { public: 0x043587cf, private: 0x04358394 };

export const NETWORKS: Record<NetworkName, Network> = {
  bitcoin: { name: 'bitcoin', btc: NETWORK, bip32: MAINNET_BIP32, coinType: 0 },
  testnet: { name: 'testnet', btc: TEST_NETWORK, bip32: TESTNET_BIP32, coinType: 1 },
  signet: { name: 'signet', btc: TEST_NETWORK, bip32: TESTNET_BIP32, coinType: 1 },
  regtest: { name: 'regtest', btc: { ...TEST_NETWORK, bech32: 'bcrt' }, bip32: TESTNET_BIP32, coinType: 1 },
};

export function getNetwork(name: string): Network {
  const n = NETWORKS[name as NetworkName];
  if (!n) throw new Error(`unknown network: ${name}`);
  return n;
}

/**
 * The BIP 48 account of the optional Savings wallet (docs/design/savings-and-limit-off.md, option K): every Savings key
 * (the phone's, the hardware wallet's and the Recovery Key's) sits at `m/48'/<coin>'/1'/2'`, so Savings has its own keys
 * and addresses, never Spending's (account 0).
 */
export const SAVINGS_ACCOUNT = 1;

/** BIP48 multisig account path for P2WSH (script type 2'). */
export function bip48Path(network: Network, account = 0): string {
  return `m/48'/${network.coinType}'/${account}'/2'`;
}
