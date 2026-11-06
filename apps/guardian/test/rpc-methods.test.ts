/**
 * The Bitcoin Core RPC calls the guardian makes, as the code makes them and as DESIGN.md lists them for an owner who
 * gives the guardian a restricted RPC user (`rpcwhitelist`; security review 2026-11, finding 5). A new call must be
 * added to `RPC_METHODS` (or `RPC_METHODS_CORE_ALONE`) and to the documented whitelist, or owners' guardians break.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS, RPC_METHODS_CORE_ALONE } from '../src/chain/bitcoind.js';

const SRC = join(import.meta.dirname, '..', 'src');
const ROOT = join(import.meta.dirname, '..', '..', '..');

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** `rpc.call<T>('method'`, `.batch('method'`, `this.call<T>('method'` ...: the method names the code sends. */
async function usedMethods(filter: (path: string) => boolean): Promise<Set<string>> {
  const found = new Set<string>();
  for (const f of (await files(SRC)).filter(filter)) {
    const text = await readFile(f, 'utf8');
    for (const m of text.matchAll(/\.(?:call|batch)(?:<[^()]*?>)?\(\s*'([a-z]+)'/g)) found.add(m[1]!);
  }
  return found;
}

describe('Bitcoin Core RPC methods', () => {
  it('the code calls exactly the listed methods', async () => {
    const all = await usedMethods(() => true);
    expect([...all].sort()).toEqual([...RPC_METHODS, ...RPC_METHODS_CORE_ALONE].sort());
    // Without Bitcoin Core alone (core-backend.ts), only the first list.
    const node = await usedMethods((f) => !f.endsWith('core-backend.ts'));
    for (const m of node) expect(RPC_METHODS as readonly string[], m).toContain(m);
  });

  it('DESIGN.md gives the whitelist an owner can copy', async () => {
    const design = await readFile(join(ROOT, 'DESIGN.md'), 'utf8');
    expect(design).toContain(`rpcwhitelist=trikey:${RPC_METHODS.join(',')}`);
    expect(design).toContain(`rpcwhitelist=trikey:${[...RPC_METHODS, ...RPC_METHODS_CORE_ALONE].join(',')}`);
  });
});
