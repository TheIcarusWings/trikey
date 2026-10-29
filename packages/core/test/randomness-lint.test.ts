/**
 * Every key and secret must come from `secureRandomBytes` (src/random.ts), which checks the source.
 * This scans the shipped sources (not tests) of every package and app that makes keys or secrets and
 * fails on the ways around it:
 *
 * - `Math.random(` (not a CSPRNG);
 * - `generateMnemonic(` (@scure/bip39 draws its own entropy; draw with `secureRandomBytes` + `entropyToMnemonic`);
 * - `generateSecretKey(` (nostr-tools draws its own; use `randomSecretKey`);
 * - `randomBytes` imported from `@noble/hashes` or `node:crypto` (unchecked; use `secureRandomBytes`).
 *
 * The allowlist names each exception and why. `apps/guardian-web` makes no keys and is not scanned.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const SCANNED = [
  'packages/core/src',
  'packages/protocol/src',
  'packages/wallet/src',
  'packages/recovery-key/src',
  'packages/silent-payments/src',
  'apps/guardian/src',
  'apps/mobile/src',
  'apps/mobile/app',
  'apps/mobile/index.ts',
];

const RULES: { name: string; re: RegExp }[] = [
  { name: 'Math.random(', re: /\bMath\.random\s*\(/ },
  { name: 'generateMnemonic(', re: /\bgenerateMnemonic\s*\(/ },
  { name: 'generateSecretKey(', re: /\bgenerateSecretKey\s*\(/ },
  { name: 'raw randomBytes import', re: /import\s*\{[^}]*\brandomBytes\b[^}]*\}\s*from\s*['"](?:@noble\/hashes[^'"]*|node:crypto|crypto)['"]/ },
  { name: 'raw randomBytes( call', re: /(?<![\w.])randomBytes\s*\(/ },
  { name: 'require of randomBytes', re: /\brequire\(\s*['"](?:node:)?crypto['"]\s*\)\.randomBytes/ },
];

/** path (from the repository root) -> rule names allowed there, with the reason. */
const ALLOW: Record<string, { rules: string[]; why: string }> = {
  'apps/guardian/src/chain/electrum.ts': { rules: ['Math.random('], why: 'reconnect jitter: timing only, no secret' },
};

function* files(path: string): Generator<string> {
  const abs = join(ROOT, path);
  const st = statSync(abs);
  if (st.isFile()) {
    yield abs;
    return;
  }
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const p = join(abs, name);
    if (statSync(p).isDirectory()) yield* files(relative(ROOT, p));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.(test|spec)\.[a-z]+$/.test(name)) yield p;
  }
}

/** Removes comments so prose that names a function does not trip the rules. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

describe('randomness lint', () => {
  it('finds sources to scan', () => {
    const n = SCANNED.flatMap((p) => [...files(p)]).length;
    expect(n).toBeGreaterThan(100);
  });

  it('no shipped source draws randomness around secureRandomBytes', () => {
    const hits: string[] = [];
    for (const dir of SCANNED) {
      for (const file of files(dir)) {
        const rel = relative(ROOT, file).split('\\').join('/');
        const lines = code(readFileSync(file, 'utf8')).split('\n');
        for (const rule of RULES) {
          if (ALLOW[rel]?.rules.includes(rule.name)) continue;
          lines.forEach((line, i) => {
            if (rule.re.test(line)) hits.push(`${rel}:${i + 1}: ${rule.name}: ${line.trim()}`);
          });
        }
      }
    }
    expect(hits, `use secureRandomBytes / randomSecretKey from @trikey/core/random instead:\n${hits.join('\n')}`).toEqual([]);
  });

  it('the rules catch what they are meant to', () => {
    const bad = [
      'const x = Math.random();',
      "const m = generateMnemonic(wordlist, 256);",
      'const sk = generateSecretKey();',
      "import { randomBytes } from '@noble/hashes/utils.js';",
      "import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';",
      "import { createHash, randomBytes } from 'node:crypto';",
      'const id = randomBytes(12);',
    ];
    for (const line of bad) expect(RULES.some((r) => r.re.test(code(line))), line).toBe(true);
    const ok = ['const k = secureRandomBytes(32);', 'const k = randomSecretKey();', '// Math.random() is not used here', "import { secureRandomBytes } from '@trikey/core/random';"];
    for (const line of ok) expect(RULES.some((r) => r.re.test(code(line))), line).toBe(false);
  });

  it('every allowlisted file still needs its exception', () => {
    for (const [rel, { rules }] of Object.entries(ALLOW)) {
      const src = code(readFileSync(join(ROOT, rel), 'utf8'));
      for (const name of rules) expect(RULES.find((r) => r.name === name)!.re.test(src), `${rel} no longer needs ${name}`).toBe(true);
    }
  });
});
