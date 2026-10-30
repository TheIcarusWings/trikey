/**
 * Every key and secret must come from `secureRandomBytes` (src/random.ts), which checks the source.
 * This scans the shipped sources (not tests) of every app and package and fails on the ways around it.
 * The checker is `test/support/randomness-check.ts` (a lexer plus token rules; its header lists what it catches):
 * `Math.random`, `randomBytes` / `randomUUID` / `randomInt` / `randomFill(Sync)` / `getRandomValues` / `randomSecretKey`
 * / `randomPrivateKey` / `getRandomBytes` however they are imported or reached (named, aliased, namespace, default,
 * `require`, dynamic `import()`, member access, destructuring), `generateMnemonic`, `generateSecretKey`, nostr-tools'
 * `wrapEvent` / `createWrap` helpers, `globalThis.crypto` / `window.crypto`, and `nip44.encrypt` without a nonce.
 *
 * The allowlist names each exception (file and rule) and why. The checker itself is tested below on snippets.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSource, type Finding, type RuleName } from './support/randomness-check.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Shipped source roots: `apps/*\/src`, `apps/*\/app`, `packages/*\/src` (found on disk) and the mobile entry file. */
function scanRoots(): string[] {
  const roots = ['apps/mobile/index.ts'];
  for (const group of ['apps', 'packages']) {
    for (const pkg of readdirSync(join(ROOT, group))) {
      for (const sub of ['src', 'app']) {
        const rel = `${group}/${pkg}/${sub}`;
        if (sub === 'app' && group === 'packages') continue;
        try {
          if (statSync(join(ROOT, rel)).isDirectory()) roots.push(rel);
        } catch {
          /* no such folder */
        }
      }
    }
  }
  return roots;
}

/** path (from the repository root) -> rule names allowed there, with the reason. */
const ALLOW: Record<string, { rules: RuleName[]; why: string }> = {
  'apps/guardian/src/chain/electrum.ts': { rules: ['Math.random'], why: 'reconnect jitter: timing only, no secret' },
  'packages/core/src/random.ts': { rules: ['random-member'], why: 'the one implementation: reads and checks globalThis.crypto.getRandomValues' },
  'apps/guardian/src/pin-random.ts': { rules: ['random-member', 'global-crypto'], why: 'pins node:crypto webcrypto.getRandomValues as the source (getrandom)' },
  'apps/mobile/src/platform/polyfills.ts': { rules: ['random-import'], why: 'imports expo-crypto getRandomValues to install it as the source, then pins it' },
  'apps/mobile/src/platform/polyfill-install.ts': { rules: ['random-member'], why: 'installs and wraps crypto.getRandomValues / randomUUID on runtimes that lack them' },
  'apps/guardian-web/src/api/mock.ts': { rules: ['random-member'], why: 'mock API data for the web UI demo: makes no keys or secrets' },
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
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.(test|spec)\.[a-z]+$/.test(name) && !name.endsWith('.d.ts')) yield p;
  }
}

const rules = (src: string): RuleName[] => checkSource(src).map((f) => f.rule);
const fmt = (f: Finding): string => `:${f.line}: ${f.rule}: ${f.name}: ${f.text}`;

describe('randomness lint (shipped sources)', () => {
  it('finds sources to scan', () => {
    const roots = scanRoots();
    for (const r of ['apps/mobile/src', 'apps/mobile/app', 'apps/guardian/src', 'apps/guardian-web/src', 'packages/core/src', 'packages/protocol/src']) expect(roots).toContain(r);
    const n = roots.flatMap((p) => [...files(p)]).length;
    expect(n).toBeGreaterThan(150);
  });

  it('no shipped source draws randomness around secureRandomBytes', () => {
    const hits: string[] = [];
    for (const dir of scanRoots()) {
      for (const file of files(dir)) {
        const rel = relative(ROOT, file).split('\\').join('/');
        for (const f of checkSource(readFileSync(file, 'utf8'))) {
          if (ALLOW[rel]?.rules.includes(f.rule)) continue;
          hits.push(rel + fmt(f));
        }
      }
    }
    expect(hits, `use secureRandomBytes / randomSecretKey from @trikey/core/random instead:\n${hits.join('\n')}`).toEqual([]);
  });

  it('every allowlisted file still needs its exception', () => {
    for (const [rel, { rules: allowed }] of Object.entries(ALLOW)) {
      const found = new Set(checkSource(readFileSync(join(ROOT, rel), 'utf8')).map((f) => f.rule));
      for (const rule of allowed) expect(found.has(rule), `${rel} no longer needs ${rule}`).toBe(true);
    }
  });
});

describe('randomness checker (snippets)', () => {
  /** [what it is, source, rules the checker must report (each at least once)] */
  const bad: [string, string, RuleName[]][] = [
    // Math.random
    ['Math.random()', 'const x = Math.random();', ['Math.random']],
    ["Math['random']()", "const x = Math['random']();", ['Math.random']],
    ['Math?.random()', 'const x = Math?.random();', ['Math.random']],
    ['globalThis.Math.random()', 'const x = globalThis.Math.random();', ['Math.random']],
    ['destructured random from Math', 'const { random } = Math;', ['Math.random']],
    // legacy rules
    ['generateMnemonic call (imported)', "import { generateMnemonic } from '@scure/bip39';\nconst m = generateMnemonic(wordlist, 256);", ['random-import']],
    ['generateMnemonic via namespace', "import * as bip39 from '@scure/bip39';\nbip39.generateMnemonic(wordlist);", ['random-member']],
    ['generateSecretKey (nostr-tools)', "import { generateSecretKey } from 'nostr-tools/pure';\nconst sk = generateSecretKey();", ['random-import']],
    ['named randomBytes import from @noble/hashes', "import { randomBytes } from '@noble/hashes/utils.js';", ['random-import']],
    ['randomBytes among several named imports', "import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';", ['random-import']],
    ['named randomBytes import from node:crypto', "import { createHash, randomBytes } from 'node:crypto';", ['random-import']],
    // crypto.randomBytes through every import form
    ['namespace import of node:crypto', "import * as crypto from 'node:crypto';\nconst b = crypto.randomBytes(32);", ['random-member']],
    ['default import of crypto', "import crypto from 'crypto';\nconst b = crypto.randomBytes(32);", ['random-member']],
    ['default import under another name', "import nodeCrypto from 'node:crypto';\nnodeCrypto.randomBytes(8);", ['random-member']],
    ["require('crypto') bound to a name", "const crypto = require('crypto');\nconst b = crypto.randomBytes(32);", ['random-member']],
    ["require('crypto').randomBytes", "const b = require('crypto').randomBytes(32);", ['random-member']],
    ["require('node:crypto')['randomBytes']", "const b = require('node:crypto')['randomBytes'](32);", ['random-member']],
    ['destructured require', "const { randomBytes } = require('crypto');", ['random-destructure']],
    ['destructured require with alias', "const { randomBytes: rb } = require('node:crypto');\nrb(32);", ['random-destructure']],
    ['dynamic import member', "const b = (await import('node:crypto')).randomBytes(32);", ['random-member']],
    ['dynamic import destructured', "const { randomBytes } = await import('node:crypto');", ['random-destructure']],
    ['dynamic import bound to a name', "const c = await import('crypto');\nc.randomFillSync(buf);", ['random-member']],
    ['import x = require()', "import crypto = require('crypto');\ncrypto.randomBytes(1);", ['random-member']],
    ['optional chaining', 'crypto?.randomBytes(4);', ['random-member']],
    ['non-null assertion', 'crypto!.randomBytes(4);', ['random-member']],
    ['re-export from noble', "export { randomBytes } from '@noble/hashes/utils.js';", ['random-import']],
    ['re-export with rename', "export { randomBytes as rb } from 'node:crypto';", ['random-import']],
    // Web Crypto
    ['crypto.getRandomValues', 'crypto.getRandomValues(new Uint8Array(32));', ['random-member']],
    ['globalThis.crypto.getRandomValues', 'globalThis.crypto.getRandomValues(buf);', ['random-member', 'global-crypto']],
    ['window.crypto', 'const c = window.crypto;', ['global-crypto']],
    ['self.crypto', 'const c = self.crypto;', ['global-crypto']],
    ['global.crypto', 'const c = global.crypto;', ['global-crypto']],
    ['window.crypto.getRandomValues', 'window.crypto.getRandomValues(buf);', ['random-member', 'global-crypto']],
    ['webcrypto.getRandomValues', "import { webcrypto } from 'node:crypto';\nwebcrypto.getRandomValues(buf);", ['random-member']],
    ["crypto['getRandomValues']", "crypto['getRandomValues'](buf);", ['random-member']],
    ['template-literal key', 'crypto[`getRandomValues`](buf);', ['random-member']],
    ['destructured getRandomValues', 'const { getRandomValues } = crypto;', ['random-destructure']],
    ['destructured from globalThis.crypto', 'const { getRandomValues: grv } = globalThis.crypto;', ['random-destructure', 'global-crypto']],
    ['named import getRandomValues from node:crypto', "import { getRandomValues } from 'node:crypto';", ['random-import']],
    ['getRandomValues from expo-crypto', "import { getRandomValues } from 'expo-crypto';", ['random-import']],
    // other draws
    ['crypto.randomUUID()', 'const id = crypto.randomUUID();', ['random-member']],
    ['randomUUID named import', "import { randomUUID } from 'node:crypto';\nrandomUUID();", ['random-import']],
    ['randomInt named import', "import { randomInt } from 'crypto';", ['random-import']],
    ['crypto.randomInt', 'crypto.randomInt(10);', ['random-member']],
    ['randomFillSync named import', "import { randomFillSync } from 'node:crypto';", ['random-import']],
    ['randomFill named import', "import { randomFill } from 'node:crypto';", ['random-import']],
    ['crypto.randomFill', 'crypto.randomFill(buf, cb);', ['random-member']],
    ['expo-crypto getRandomBytes', "import { getRandomBytes } from 'expo-crypto';", ['random-import']],
    ['expo-crypto getRandomBytesAsync', "import * as Crypto from 'expo-crypto';\nawait Crypto.getRandomBytesAsync(32);", ['random-member']],
    ['ExpoCrypto.getRandomBytes', 'ExpoCrypto.getRandomBytes(16);', ['random-member']],
    // noble / scure
    ['secp256k1.utils.randomSecretKey', "import { secp256k1 } from '@noble/curves/secp256k1.js';\nsecp256k1.utils.randomSecretKey();", ['random-member']],
    ['schnorr.utils.randomSecretKey', 'schnorr.utils.randomSecretKey();', ['random-member']],
    ['utils.randomPrivateKey', 'ed25519.utils.randomPrivateKey();', ['random-member']],
    ['curve.keygen()', 'const { secretKey } = secp256k1.keygen();', ['random-member']],
    ['randomBytes from @noble/ciphers', "import { randomBytes } from '@noble/ciphers/utils.js';", ['random-import']],
    ['randomBytes from @noble/curves', "import { randomBytes } from '@noble/curves/utils.js';", ['random-import']],
    ['randomBytes from @scure/btc-signer', "import { randomBytes } from '@scure/btc-signer/utils.js';", ['random-import']],
    ['randomBytes from @noble/hashes root', "import { randomBytes } from '@noble/hashes/utils';", ['random-import']],
    ['namespace import of noble utils', "import * as u from '@noble/hashes/utils.js';\nu.randomBytes(32);", ['random-member']],
    ['randomSecretKey from noble', "import { randomSecretKey } from '@noble/curves/utils.js';", ['random-import']],
    // multi-line and aliased imports
    ['multi-line aliased import', "import {\n  bytesToHex,\n  randomBytes as rb,\n} from '@noble/hashes/utils.js';\nconst k = rb(32);", ['random-import']],
    ['aliased import, one line', "import { randomBytes as rb } from '@noble/hashes/utils.js';", ['random-import']],
    ['default plus named import', "import crypto, { randomBytes } from 'node:crypto';", ['random-import']],
    ['import with type modifier on another member', "import { type Foo, randomBytes } from 'node:crypto';", ['random-import']],
    ['default plus namespace import', "import d, * as ns from 'node:crypto';\nns.randomBytes(1);", ['random-member']],
    // nostr-tools
    ['nip44.encrypt without a nonce (namespace)', "import * as nip44 from 'nostr-tools/nip44';\nconst c = nip44.encrypt(text, key);", ['nip44-no-nonce']],
    ['nip44.encrypt without a nonce (dynamic import)', "const nip44 = await import('nostr-tools/nip44');\nnip44.encrypt(plaintext, nip44.getConversationKey(a, b));", ['nip44-no-nonce']],
    ['nip44.encrypt without a nonce (named import)', "import { encrypt } from 'nostr-tools/nip44';\nencrypt(text, key);", ['nip44-no-nonce']],
    ['nip44.encrypt without a nonce (aliased import)', "import { encrypt as enc } from 'nostr-tools/nip44';\nenc(text, key);", ['nip44-no-nonce']],
    ['nip44.encrypt without a nonce (nip44 from the root package)', "import { nip44 } from 'nostr-tools';\nnip44.encrypt(text, key);", ['nip44-no-nonce']],
    ['nip44.encrypt without a nonce (through a namespace of the root package)', "import * as nt from 'nostr-tools';\nnt.nip44.encrypt(text, key);", ['nip44-no-nonce']],
    ['nip44.v2.encrypt without a nonce', "import * as nip44 from 'nostr-tools/nip44';\nnip44.v2.encrypt(text, key);", ['nip44-no-nonce']],
    ['nip44.encrypt without a nonce (inline module)', "const c = (await import('nostr-tools/nip44')).encrypt(text, key);", ['nip44-no-nonce']],
    ['nip44.encrypt without a nonce (destructured dynamic import)', "const { encrypt } = await import('nostr-tools/nip44');\nencrypt(text, key);", ['nip44-no-nonce']],
    ['nip44.encrypt without a nonce, split over lines', "import * as nip44 from 'nostr-tools/nip44';\nnip44.encrypt(\n  text,\n  key,\n);", ['nip44-no-nonce']],
    ['nip44.encrypt with undefined as nonce', "import * as nip44 from 'nostr-tools/nip44';\nnip44.encrypt(text, key, undefined);", ['nip44-no-nonce']],
    ['nip44.encrypt with a spread', "import * as nip44 from 'nostr-tools/nip44';\nnip44.encrypt(...args);", ['nip44-no-nonce']],
    ['nip44.encrypt passed around uncalled', "import * as nip44 from 'nostr-tools/nip44';\nconst e = nip44.encrypt;", ['nip44-no-nonce']],
    ['nip44.encrypt, nested call hides the comma', "import * as nip44 from 'nostr-tools/nip44';\nnip44.encrypt(f(text, key), key);", ['nip44-no-nonce']],
    ['nip17.wrapEvent', "import { wrapEvent } from 'nostr-tools/nip17';\nwrapEvent(sk, { publicKey }, text);", ['random-import']],
    ['nip59.wrapEvent via namespace', "import * as nip59 from 'nostr-tools/nip59';\nnip59.wrapEvent(rumor, sk, pk);", ['random-member']],
    ['nip17.wrapManyEvents', "import * as nip17 from 'nostr-tools/nip17';\nnip17.wrapManyEvents(sk, recipients, text);", ['random-member']],
    ['nip59 createWrap', "import { createWrap } from 'nostr-tools/nip59';", ['random-import']],
    ['nip59 createSeal', "import { createSeal, createRumor } from 'nostr-tools/nip59';", ['random-import']],
    // inside code the lexer must still read
    ['inside a template substitution', 'const s = `id-${crypto.randomUUID()}`;', ['random-member']],
    ['inside a nested template', 'const s = `a ${`b ${Math.random()}`}`;', ['Math.random']],
    ['after a regex containing a quote', "const r = /[\"']/g; const x = Math.random();", ['Math.random']],
    ['after a division', 'const h = a / 2; const x = Math.random() / 3;', ['Math.random']],
    ['after a JSX closing tag', 'const e = <Text>hi</Text>; const y = <b>{Math.random()}</b>;', ['Math.random']],
    ['in an arrow function parameter pattern', "import('node:crypto').then(({ randomBytes }) => randomBytes(8));", ['random-destructure']],
  ];

  for (const [what, src, expected] of bad) {
    it(`flags ${what}`, () => {
      const got = rules(src);
      for (const rule of expected) expect(got, `${src}\n=> ${JSON.stringify(checkSource(src))}`).toContain(rule);
    });
  }

  /** Code that must not be flagged. */
  const good: [string, string][] = [
    ['secureRandomBytes', "import { secureRandomBytes } from '@trikey/core/random';\nconst k = secureRandomBytes(32);"],
    ['randomSecretKey from @trikey/core/random', "import { randomSecretKey } from '@trikey/core/random';\nconst k = randomSecretKey();"],
    ['randomSecretKey through a namespace of @trikey/core/random', "import * as rnd from '@trikey/core/random';\nrnd.randomSecretKey();"],
    ['randomSecretKey destructured from a dynamic import of @trikey/core/random', "const { randomSecretKey } = await import('@trikey/core/random');\nrandomSecretKey();"],
    ['member of a dynamic import of @trikey/core/random', "const k = (await import('@trikey/core/random')).randomSecretKey();"],
    ['relative import of a local helper with the same name', "import { randomBytes } from './helpers';\nrandomBytes(3);"],
    ['a local variable named randomBytes', 'const randomBytes = (n: number) => new Uint8Array(n);\nrandomBytes(32);'],
    ['a local function named randomBytes', 'function randomBytes(n: number) { return new Uint8Array(n); }\nconst b = randomBytes(8);'],
    ['a parameter named randomBytes', 'const f = (randomBytes: (n: number) => Uint8Array) => randomBytes(4);'],
    ['a local named getRandomValues', 'const getRandomValues = () => 1;\ngetRandomValues();'],
    ['an object key named randomBytes in a literal', 'const o = { randomBytes: 1 };'],
    ['a shorthand property from a local', 'const randomBytes = 1;\nconst o = { randomBytes };'],
    ['a type annotation with randomBytes', 'let x: { randomBytes: () => void } = y;'],
    ['an interface method named randomBytes', 'interface Rng { randomBytes(n: number): Uint8Array; getRandomValues<T>(a: T): T }'],
    ['an array holding a string called getRandomValues', "const names = ['getRandomValues', 'randomBytes'];"],
    ['a line comment', '// Math.random() and crypto.randomBytes(32) are not used here\nconst x = 1;'],
    ['a block comment', '/* import { randomBytes } from "node:crypto"; crypto.getRandomValues(b) */ const x = 1;'],
    ['a multi-line block comment', '/**\n * crypto.randomUUID()\n * Math.random()\n */\nconst x = 1;'],
    ['a double-quoted string', 'const s = "call crypto.randomBytes(32) and Math.random()";'],
    ['a single-quoted string', "const s = 'crypto.getRandomValues is not available';"],
    ['a template string', 'const s = `window.crypto.getRandomValues(${n})`;'],
    ['a string that is a whole import', "const s = \"import { randomBytes } from 'node:crypto'\";"],
    ['an apostrophe in a comment', "// don't use Math.random()\nconst x = 1;"],
    ['a URL in a string', "const u = 'https://example.com/randomBytes'; const y = 2;"],
    ['a regex literal', 'const r = /Math\\.random\\(\\)/;'],
    ['import type', "import type { randomBytes } from 'node:crypto';"],
    ['inline type import', "import { type randomBytes, createHash } from 'node:crypto';"],
    ['export type', "export type { randomBytes } from 'node:crypto';"],
    ['hashing with node:crypto', "import { createHash, timingSafeEqual } from 'node:crypto';\ncreateHash('sha256').update(x).digest();"],
    ['webcrypto imported but not used to draw', "import { webcrypto } from 'node:crypto';\nconst s = webcrypto.subtle;"],
    ['crypto.subtle', "const k = await crypto.subtle.digest('SHA-256', data);\nconst j = globalThis.crypto.subtle;"],
    ['Math functions other than random', 'const x = Math.floor(Math.max(1, 2));'],
    ['a variable named Math2', 'const Math2 = { random: 1 };\nMath2.x;'],
    ['nip44.encrypt with an explicit nonce', "import * as nip44 from 'nostr-tools/nip44';\nconst c = nip44.encrypt(text, key, nonce);"],
    ['nip44.encrypt with a nonce from secureRandomBytes', "import * as nip44 from 'nostr-tools/nip44';\nnip44.encrypt(text, key, secureRandomBytes(32));"],
    ['nip44.encrypt with nested calls and a nonce', "import * as nip44 from 'nostr-tools/nip44';\nnip44.encrypt(f(a, b), g(c, d), secureRandomBytes(32),);"],
    ['nip44.encrypt split over lines with a nonce', "import * as nip44 from 'nostr-tools/nip44';\nnip44.encrypt(\n  text,\n  key,\n  nonce,\n);"],
    ['nip44.decrypt', "import * as nip44 from 'nostr-tools/nip44';\nnip44.decrypt(payload, key);"],
    ['nip44.getConversationKey', "import * as nip44 from 'nostr-tools/nip44';\nnip44.getConversationKey(a, b);"],
    ['an unrelated encrypt (own cipher, two arguments)', "import { encrypt } from './cipher';\nencrypt(a, b);"],
    ['an unrelated encrypt method', 'cipher.encrypt(a, b);'],
    ['an encrypt on a namespace of another package', "import * as nip04 from 'nostr-tools/nip04';\nnip04.encrypt(sk, pk, text);"],
    ['unwrapping a gift wrap', "import { unwrapEvent } from 'nostr-tools/nip59';\nunwrapEvent(wrap, sk);"],
    ["the project's own wrapMessage", 'const w = wrapMessage(rumor, sk, pk);'],
    ['a local wrapEvent', 'function wrapEvent() {}\nwrapEvent();'],
    ['side-effect import of the native polyfill', "import 'react-native-get-random-values';"],
    ['computed access with another key', "const v = obj['value']; const w = [1, 2][0];"],
    ['array literal after return', "function f() { return ['randomBytes']; }"],
    ['destructuring unrelated keys', "const { createHash, timingSafeEqual } = require('node:crypto');"],
    ['class with a method named randomBytes declared (no call on a receiver)', 'class Rng { randomBytes(n: number) { return new Uint8Array(n); } }'],
  ];

  for (const [what, src] of good) {
    it(`does not flag ${what}`, () => {
      expect(checkSource(src), src).toEqual([]);
    });
  }

  it('reports the line and the source text', () => {
    const src = "import { createHash } from 'node:crypto';\n\n/* a\n   comment */\nconst a = 1;\nconst id = crypto.randomUUID();\n";
    expect(checkSource(src)).toEqual([{ rule: 'random-member', line: 6, name: 'randomUUID', text: 'const id = crypto.randomUUID();' }]);
  });

  it('reports every violation, in line order', () => {
    const src = "import { randomBytes } from 'node:crypto';\nconst a = Math.random();\nwindow.crypto.getRandomValues(b);\n";
    expect(checkSource(src).map((f) => [f.line, f.rule])).toEqual([
      [1, 'random-import'],
      [2, 'Math.random'],
      [3, 'global-crypto'],
      [3, 'random-member'],
    ]);
  });

  it('is not fooled by multi-line imports or comments between the parts', () => {
    const src = "import {\n  // keep this one\n  randomBytes /* aliased */ as rb,\n} from\n  '@noble/hashes/utils.js';\n";
    expect(rules(src)).toEqual(['random-import']);
  });

  it('tells a pattern from a type', () => {
    expect(rules("const { randomBytes } = foo;")).toEqual(['random-destructure']);
    expect(rules("const x: { randomBytes: number } = foo;")).toEqual([]);
    expect(rules("const { a: { randomBytes } } = foo;")).toEqual(['random-destructure']);
    expect(rules("const { randomBytes: local } = foo;")).toEqual(['random-destructure']);
    expect(rules("const { local: randomBytes } = foo;")).toEqual([]);
  });
});
