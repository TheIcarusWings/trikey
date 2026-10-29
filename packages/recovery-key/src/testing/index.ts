/**
 * Test and developer-menu helpers: a simulated chain and the Esplora API over
 * it, in-process (`simFetch`). The HTTP server is in
 * `@trikey/recovery-key/testing/server` (Node only).
 *
 * NEVER for real funds: the simulated chain refuses network `bitcoin`.
 */
export { SimChain, SimRejection } from './sim-chain.js';
export { routeEsplora, simFetch, type FakeEsploraHooks, type RouteResult } from './esplora-routes.js';
