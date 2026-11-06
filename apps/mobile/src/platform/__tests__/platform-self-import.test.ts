/**
 * A platform file (`x.native.ts`, `x.ios.ts`, `x.android.ts`) must not import a VALUE from './x': on a phone Metro
 * resolves './x' to the platform file itself, so the module depends on itself, and a re-exported value becomes a getter
 * that reads itself forever. 0.1.18 crashed at every iPhone launch that way (hardware/nfc/transport.native.ts imported
 * `noNfc` from './transport'). Node resolves './x' to x.ts, so no other test sees it. `import type` is erased and fine.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const DIRS = ['src', 'app', 'modules'];
const PLATFORM = /\.(native|ios|android)\.(ts|tsx|js|jsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (PLATFORM.test(n)) out.push(p);
  }
  return out;
}

/** Value imports and re-exports of './<base>' in `source` (type-only ones are left out). */
export function selfValueImports(source: string, base: string): string[] {
  const spec = `['"]\\./${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`;
  const re = new RegExp(`^\\s*(import|export)\\b([^;]*?)\\bfrom\\s*${spec}`, 'gms');
  const hits: string[] = [];
  for (const m of source.matchAll(re)) {
    const clause = m[2]!.trim();
    if (/^type\b/.test(clause)) continue; // import type { … } / export type { … }
    // import { type A, type B } (every name type-only) is erased too.
    const braces = /^\{([^}]*)\}$/.exec(clause);
    if (braces && braces[1]!.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '))) continue;
    hits.push(m[0].trim());
  }
  // A bare side-effect import of itself.
  if (new RegExp(`^\\s*import\\s*${spec}`, 'm').test(source)) hits.push(`import './${base}'`);
  return hits;
}

describe('platform files never import a value from their own name', () => {
  it('catches the 0.1.18 line, and lets type-only imports through', () => {
    expect(selfValueImports("import { noNfc, type NfcTransport } from './transport';", 'transport')).toHaveLength(1);
    expect(selfValueImports("export { noNfc } from './transport';", 'transport')).toHaveLength(1);
    expect(selfValueImports("import './transport';", 'transport')).toHaveLength(1);
    expect(selfValueImports("import type { NfcTransport } from './transport';", 'transport')).toEqual([]);
    expect(selfValueImports("import { type A, type B } from './transport';", 'transport')).toEqual([]);
    expect(selfValueImports("import { noNfc } from './no-nfc';", 'transport')).toEqual([]);
  });

  it('in every platform file of the app', () => {
    const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(5);
    const bad = files.flatMap((f) => selfValueImports(readFileSync(f, 'utf8'), basename(f).replace(PLATFORM, '')).map((h) => `${f}: ${h}`));
    expect(bad).toEqual([]);
  });
});
