/**
 * Test support shared with other packages (`@trikey/guardian/testing`): the
 * fake Electrs and a rig that runs the real guardian service in-process. For
 * tests only; regtest only.
 */
export { FakeElectrum, headerHash, makeHeader, type FakeUtxo } from './fake-electrum.js';
export { GuardianRig, type FundedOutput, type GuardianRigOptions } from './rig.js';
export { Guardian, RECOVERY_PEER_METHODS } from '../../src/guardian.js';
export { DAY, HOUR, ManualClock } from '../../src/policy/index.js';
