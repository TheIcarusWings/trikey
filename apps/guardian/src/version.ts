import { readFileSync } from 'node:fs';

/**
 * Reported in `guardian.status`, `pair.prepare` and `pair`, and logged at start: the guardian's package.json
 * version, read once (the release process bumps it; a hard-coded copy here went stale).
 */
export const GUARDIAN_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
