/**
 * Where the guardian reads the blockchain, as Settings > Guardian shows it (`guardian.status.chainSource`). The owner
 * chooses it in the guardian's web page (Settings, Server); the phone only shows it. Guardians before the choice
 * existed say nothing: they use the box's own node.
 */
export interface GuardianChainSource {
  kind: 'own' | 'public';
  backend: 'electrum' | 'core';
  host: string;
}

/** The warning next to a public server. */
export const PUBLIC_SERVER_WARNING =
  "Your guardian reads the blockchain from a public server. That server sees your wallet's addresses and your guardian's IP address, and could hide coins or delay confirmations. It cannot spend or change your rules. Use your own node if you can: change it in the guardian's web page, Settings, Server.";

/** The "Chain data" row: "Your node", "Your node (Bitcoin Core)", or "Public server: mempool.space". */
export function chainDataLabel(cs: GuardianChainSource | undefined): string {
  if (!cs || cs.kind === 'own') return cs?.backend === 'core' ? 'Your node (Bitcoin Core)' : 'Your node';
  return `Public server: ${cs.host}`;
}
