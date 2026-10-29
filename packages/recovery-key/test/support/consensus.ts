/**
 * A tiny local runner for tools/consensus-verify (libbitcoinconsensus, Bitcoin
 * Core's script verifier). Uses `CONSENSUS_VERIFY_BIN` or the binary that
 * `npm run build:verifier` builds; tests that need it are skipped when it is
 * missing. (A shared helper is coming in packages/core/test/support; this one
 * can go once it lands.)
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BIN = resolve(here, '../../../../tools/consensus-verify/target/release/consensus-verify');

export const consensusVerifier: string | undefined = [process.env.CONSENSUS_VERIFY_BIN, DEFAULT_BIN].find((p): p is string => !!p && existsSync(p));

/** Checks every input of `txHex` under all pre-taproot consensus flags. */
export function consensusVerify(txHex: string, prevouts: { script: Uint8Array | string; amount: bigint | number }[]): { ok: boolean; output: string } {
  if (!consensusVerifier) throw new Error('consensus-verify is not built');
  const toHex = (s: Uint8Array | string) => (typeof s === 'string' ? s : Buffer.from(s).toString('hex'));
  const input = JSON.stringify({ tx: txHex, prevouts: prevouts.map((p) => ({ script: toHex(p.script), amount: Number(p.amount) })) });
  const r = spawnSync(consensusVerifier, { input, encoding: 'utf8' });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
