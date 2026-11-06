import { JadeBleBridge } from './bridge';
import { defaultJadeBleLink } from './link';

/** The bridge used when none is passed in: the Jade provider uses it, and `JadeBleBridgeHost` mounts on it by default. */
export const defaultJadeBleBridge = new JadeBleBridge(defaultJadeBleLink());
