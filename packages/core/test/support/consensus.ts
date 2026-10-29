/**
 * Checks transactions against Bitcoin Core's real consensus rules.
 *
 * Runs `tools/consensus-verify` (the `bitcoinconsensus` crate, i.e. Bitcoin Core's
 * script interpreter) on a fully signed raw transaction and the outputs it spends.
 * Other packages' tests can import this as `@trikey/core/testing`.
 *
 * Build the binary with `npm run build:verifier`. Without it, consensus tests are
 * skipped locally (with a message) and fail when `CI` is set, so CI can never
 * quietly stop checking.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { parsePsbt } from '../../src/psbt.js';

/** An output being spent: its scriptPubKey and amount in satoshis. */
export interface SpentOutput {
  script: Uint8Array | string;
  amount: bigint | number;
}

export interface InputResult {
  index: number;
  ok: boolean;
  /** The verifier's error for a failed input, e.g. `ERR_SCRIPT`. */
  error?: string;
}

export interface ConsensusResult {
  /** True when every input verified. */
  ok: boolean;
  inputs: InputResult[];
  /** The verifier's raw output, for debugging. */
  output: string;
}

/** Flag names understood by the verifier. Omit `flags` for every flag before taproot. */
export type ConsensusFlag =
  | 'P2SH'
  | 'DERSIG'
  | 'NULLDUMMY'
  | 'CHECKLOCKTIMEVERIFY'
  | 'CHECKSEQUENCEVERIFY'
  | 'WITNESS'
  | 'ALL_PRE_TAPROOT';

const DEFAULT_BINARY = fileURLToPath(
  new URL(
    `../../../../tools/consensus-verify/target/release/consensus-verify${process.platform === 'win32' ? '.exe' : ''}`,
    import.meta.url,
  ),
);

export const isCI = (): boolean => {
  const v = process.env.CI;
  return !!v && v !== 'false' && v !== '0';
};

/** Path of the verifier binary: `TRIKEY_CONSENSUS_VERIFY`, else the release build in `tools/`. */
export function verifierPath(): string {
  return process.env.TRIKEY_CONSENSUS_VERIFY || DEFAULT_BINARY;
}

export function verifierAvailable(): boolean {
  return existsSync(verifierPath());
}

const BUILD_HINT = 'build it with `npm run build:verifier` (needs Rust), or set TRIKEY_CONSENSUS_VERIFY';

let warned = false;

/**
 * Like `describe`, for tests that need the verifier. Skips with a clear message
 * when the binary is missing, except in CI where it fails instead.
 */
export function describeConsensus(name: string, fn: () => void): void {
  if (process.env.TRIKEY_CONSENSUS_VERIFY && !verifierAvailable()) {
    // A wrong explicit path is a setup bug, never a reason to skip.
    describe(name, () => {
      it('consensus verifier is at TRIKEY_CONSENSUS_VERIFY', () => {
        throw new Error(`TRIKEY_CONSENSUS_VERIFY points to a missing file: ${verifierPath()}`);
      });
    });
  } else if (verifierAvailable()) {
    describe(name, fn);
  } else if (isCI()) {
    describe(name, () => {
      it('consensus verifier binary is present (required in CI)', () => {
        throw new Error(`consensus-verify not found at ${verifierPath()}; ${BUILD_HINT}`);
      });
    });
  } else {
    if (!warned) {
      warned = true;
      process.stderr.write(`\nconsensus tests SKIPPED: consensus-verify not found at ${verifierPath()}; ${BUILD_HINT}\n\n`);
    }
    describe.skip(`${name} (SKIPPED: consensus-verify not built; ${BUILD_HINT})`, fn);
  }
}

/**
 * For a test that needs the verifier but can carry on without it: returns false
 * when the verifier is missing, so the caller can skip that part. Throws instead
 * in CI (and when TRIKEY_CONSENSUS_VERIFY names a missing file), so a missing
 * verifier fails the test rather than passing quietly.
 */
export function consensusAvailable(): boolean {
  if (verifierAvailable()) return true;
  if (process.env.TRIKEY_CONSENSUS_VERIFY) throw new Error(`TRIKEY_CONSENSUS_VERIFY points to a missing file: ${verifierPath()}`);
  if (isCI()) throw new Error(`consensus-verify not found at ${verifierPath()}; ${BUILD_HINT}`);
  return false;
}

const toHex = (b: Uint8Array | string) => (typeof b === 'string' ? b : hex.encode(b));

/**
 * Verifies every input of `txHex` under Bitcoin Core's script rules.
 * `spent` has one entry per input, in input order.
 */
export function verifyConsensus(txHex: string, spent: SpentOutput[], opts: { flags?: ConsensusFlag[] } = {}): ConsensusResult {
  const nInputs = btc.RawTx.decode(hex.decode(txHex)).inputs.length;
  if (spent.length !== nInputs) {
    throw new Error(`transaction has ${nInputs} inputs but ${spent.length} spent outputs were given`);
  }
  const req = {
    tx: txHex,
    prevouts: spent.map((s) => ({ script: toHex(s.script), amount: Number(s.amount) })),
    ...(opts.flags ? { flags: opts.flags } : {}),
  };
  const run = spawnSync(verifierPath(), { input: JSON.stringify(req), encoding: 'utf8' });
  if (run.error) throw new Error(`could not run consensus-verify at ${verifierPath()}: ${run.error.message}`);
  // Exit 0: all inputs valid. Exit 1: some input invalid. Anything else is a broken request.
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(`consensus-verify failed (exit ${run.status}): ${run.stderr.trim() || run.stdout.trim()}`);
  }
  const inputs: InputResult[] = [];
  for (const line of run.stdout.split('\n')) {
    const m = /^input (\d+): (ok|FAIL (\S+))$/.exec(line.trim());
    if (!m) continue;
    inputs.push({ index: Number(m[1]), ok: m[2] === 'ok', error: m[3] });
  }
  if (inputs.length !== nInputs) throw new Error(`consensus-verify reported ${inputs.length} of ${nInputs} inputs:\n${run.stdout}`);
  return { ok: run.status === 0, inputs, output: run.stdout };
}

/** The outputs a PSBT's inputs spend (from each input's `witnessUtxo`). */
export function spentOutputsOfPsbt(psbt: Uint8Array): SpentOutput[] {
  const tx = parsePsbt(psbt);
  const out: SpentOutput[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const u = tx.getInput(i).witnessUtxo;
    if (!u) throw new Error(`input ${i}: no witnessUtxo`);
    out.push({ script: u.script, amount: u.amount });
  }
  return out;
}

/** Throws with the verifier's output unless every input verifies. */
export function assertConsensusValid(r: ConsensusResult): void {
  if (!r.ok) throw new Error(`consensus verification failed:\n${r.output}`);
}

/**
 * Throws unless the verifier rejected the transaction. `inputs` lists the input
 * indexes that must fail (default: at least one).
 */
export function assertConsensusInvalid(r: ConsensusResult, inputs?: number[]): void {
  if (r.ok) throw new Error('expected consensus verification to fail, but every input verified');
  if (!inputs) return;
  const failed = r.inputs.filter((i) => !i.ok).map((i) => i.index);
  if (failed.join() !== [...inputs].sort((a, b) => a - b).join()) {
    throw new Error(`expected inputs [${inputs}] to fail consensus, got [${failed}]:\n${r.output}`);
  }
}
