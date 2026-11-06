import { BitBoxBridge } from './bridge';
import { defaultBitBoxLinks } from './link';

/** The bridge used when none is passed in: the BitBox02 provider uses it, and `BitBox02BridgeHost` mounts on it by default. */
export const defaultBitBoxBridge = new BitBoxBridge(defaultBitBoxLinks());
