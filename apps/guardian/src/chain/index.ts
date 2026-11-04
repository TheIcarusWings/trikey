/** The chain sources, for other workspaces' tests (`@trikey/guardian/chain`). */
export { ChainService } from './chain.js';
export { ElectrumBackend, type ChainBackend } from './backend.js';
export { CoreBackend } from './core-backend.js';
export { BitcoinRpc } from './bitcoind.js';
export { ElectrumClient } from './electrum.js';
export { buildBackend, parseChainSource, type ChainSource } from './source.js';
