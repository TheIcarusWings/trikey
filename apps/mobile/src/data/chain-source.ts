/**
 * Where the guardian reads the blockchain, as Settings > Guardian shows it (`guardian.status.chainSource`). The owner
 * chooses it in the guardian's web page (Settings, Server); the phone only shows it. Guardians before the choice
 * existed say nothing: they use the box's own node.
 */
export interface GuardianChainSource {
  kind: 'own' | 'public';
  backend: 'electrum' | 'core';
  host: string;
  /** `unseen`: the guardian found that its Electrum server reports no unconfirmed transactions (`MEMPOOL_UNSEEN_NOTE`). */
  mempool?: 'unseen';
}

/**
 * The quiet note under "Chain data" while the guardian's Electrum server reports no unconfirmed transactions. Payments
 * from this phone still show at once (the phone and the guardian keep them); payments to it wait for a block.
 */
export const MEMPOOL_UNSEEN_NOTE = "Your guardian's Electrum server doesn't report unconfirmed payments: payments to you show once confirmed.";

/** Whether to show `MEMPOOL_UNSEEN_NOTE`. */
export function mempoolUnseen(cs: GuardianChainSource | undefined): boolean {
  return cs?.mempool === 'unseen';
}

/** The warning next to a public server. */
export const PUBLIC_SERVER_WARNING =
  "Your guardian reads the blockchain from a public server. That server sees your wallet's addresses and your guardian's IP address, and could hide coins or delay confirmations. It cannot spend or change your rules. Use your own node if you can: change it in the guardian's web page, Settings, Server.";

/** The "Chain data" row: "Your node", "Your node (Bitcoin Core)", or "Public server: mempool.space". */
export function chainDataLabel(cs: GuardianChainSource | undefined): string {
  if (!cs || cs.kind === 'own') return cs?.backend === 'core' ? 'Your node (Bitcoin Core)' : 'Your node';
  return `Public server: ${cs.host}`;
}

/**
 * A hosted wallet's "Host's server" row: where the HOST's guardian reads the chain (`guardian.status.chainSource` from a
 * host, which names a public server but never the host's own node). It checks this wallet's recovery coins and relays
 * its payments there; the phone itself reads the wallet from its own chain server.
 */
export function hostChainDataLabel(cs: GuardianChainSource | undefined): string {
  if (!cs || cs.kind === 'own') return "Host's own node";
  return `Public server: ${cs.host}`;
}
