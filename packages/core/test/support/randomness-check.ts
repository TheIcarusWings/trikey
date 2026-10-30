/**
 * The checker behind `test/randomness-lint.test.ts`: finds the ways a source file can draw randomness without
 * going through `secureRandomBytes` / `@trikey/core/random`.
 *
 * It is a small lexer plus token-level rules, not regexes over lines, so comments, strings and template text
 * never match, and aliased, namespace, default, multi-line, `require` and dynamic imports are followed. (It is
 * not built on the TypeScript compiler API: the repository uses TypeScript 7, whose JavaScript API is only the
 * unstable `typescript/unstable/*` IPC client, not a synchronous in-process parser.)
 *
 * What it reports (`Finding.rule`):
 *
 * - `Math.random`: `Math.random`, `Math['random']`, `Math?.random`, `const { random } = Math`.
 * - `random-import`: a random-drawing function imported (or re-exported) from a package: `randomBytes`,
 *   `randomFill(Sync)`, `randomInt`, `randomUUID`, `getRandomValues`, `randomSecretKey`, `randomPrivateKey`,
 *   `getRandomBytes(Async)` (node:crypto, expo-crypto, any @noble/* or @scure/*, ...), plus functions that draw
 *   their own randomness (`generateMnemonic`, `generateSecretKey`, `generatePrivateKey`, and nostr-tools'
 *   `wrapEvent`, `wrapManyEvents`, `createWrap`, `createSeal`). Aliases (`randomBytes as rb`) are caught at the import.
 * - `random-member`: the same names (and `keygen`) reached through a member access on anything that is not our
 *   own code: `crypto.randomBytes`, `ns.randomUUID`, `webcrypto.getRandomValues`, `utils.randomSecretKey`,
 *   `schnorr.utils.randomPrivateKey`, `require('crypto').randomInt`, `(await import('x')).randomBytes`, `x?.y`, `x['y']`.
 * - `random-destructure`: the same names pulled out of an object: `const { randomBytes } = require('crypto')`,
 *   `const { getRandomValues } = crypto`, `({ randomBytes }) => ...`.
 * - `global-crypto`: `globalThis.crypto`, `window.crypto`, `self.crypto`, `global.crypto` (other than `.subtle`).
 * - `nip44-no-nonce`: a nostr-tools NIP-44 `encrypt` called with fewer than three arguments (it then draws its own
 *   nonce), with a spread, with `undefined` as the nonce, or used without calling it.
 *
 * "Our own code" means a relative import or an `@trikey/*` package: those files are scanned themselves, so a name
 * imported from them is not flagged (that is how `randomSecretKey` from `@trikey/core/random` stays legal).
 *
 * Known limits: it follows names, not values, so `const m = Math; m.random()`, `const c = crypto; c['get' + 'RandomValues']`
 * and a function declared elsewhere that wraps the primitive are not seen; it does not look inside dependencies; JSX text
 * that contains `//` hides the rest of its line.
 */

export type RuleName = 'Math.random' | 'random-import' | 'random-member' | 'random-destructure' | 'global-crypto' | 'nip44-no-nonce';

export interface Finding {
  rule: RuleName;
  line: number;
  /** The identifier or call at fault. */
  name: string;
  /** The source line, trimmed. */
  text: string;
}

/** Functions and properties that draw bytes from a source the continuous tests in `random.ts` do not see. */
const RANDOM_SOURCES = new Set([
  'randomBytes',
  'randomFill',
  'randomFillSync',
  'randomInt',
  'randomUUID',
  'getRandomValues',
  'randomSecretKey',
  'randomPrivateKey',
  'getRandomBytes',
  'getRandomBytesAsync',
]);

/** Helpers that draw their own randomness inside (so there is no way to hand them `secureRandomBytes`). */
const SELF_DRAWING = new Set(['generateMnemonic', 'generateSecretKey', 'generatePrivateKey', 'wrapEvent', 'wrapManyEvents', 'createWrap', 'createSeal']);

/** Names that are only suspicious as a member (`curve.keygen()` draws a secret key; a bare `keygen` is not ours to judge). */
const MEMBER_ONLY = new Set(['keygen']);

const IMPORT_NAMES = new Set([...RANDOM_SOURCES, ...SELF_DRAWING]);
const MEMBER_NAMES = new Set([...RANDOM_SOURCES, ...SELF_DRAWING, ...MEMBER_ONLY]);
const GLOBAL_ROOTS = new Set(['window', 'self', 'globalThis', 'global']);
const NIP44_MODULE = /^nostr-tools\/(?:lib\/[\w/]*\/)?nip44(?:\.[cm]?js)?$/;
const REGEX_PRECEDING_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'void', 'delete', 'throw', 'yield', 'await', 'of']);
const NOT_AN_OPERAND = new Set([...REGEX_PRECEDING_KEYWORDS, 'extends', 'export', 'default', 'import', 'const', 'let', 'var', 'function', 'class', 'if', 'for', 'while', 'switch', 'with']);

const isOwnModule = (m: string): boolean => m.startsWith('.') || m.startsWith('/') || m.startsWith('@trikey/');

interface Tok {
  /** `id` identifier or keyword, `str` string (or template without substitutions), `p` punctuator, `re` regex literal, `num`. */
  t: 'id' | 'str' | 'p' | 're' | 'num';
  v: string;
  line: number;
}

const PUNCT = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
];

const isIdStart = (c: string): boolean => /[A-Za-z_$\u0080-￿]/.test(c);
const isIdPart = (c: string): boolean => /[\w$\u0080-￿]/.test(c);

/** Lexes JavaScript/TypeScript/TSX into tokens, dropping comments and keeping string contents out of the identifier stream. */
export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  /** `b` for `{`, `t` for a `${` inside a template literal. */
  const stack: ('b' | 't')[] = [];

  /** Reads template text from `i` (just after a backtick or a closing `}` of a substitution) up to the closing backtick or the next `${`. */
  const template = (startLine: number, text: string): void => {
    while (i < n) {
      const c = src[i]!;
      if (c === '\\') {
        text += src[i + 1] ?? '';
        if (src[i + 1] === '\n') line++;
        i += 2;
      } else if (c === '`') {
        i++;
        toks.push({ t: 'str', v: text, line: startLine });
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        i += 2;
        stack.push('t');
        toks.push({ t: 'str', v: '', line: startLine });
        return;
      } else {
        if (c === '\n') line++;
        text += c;
        i++;
      }
    }
  };

  const prev = (): Tok | undefined => toks[toks.length - 1];
  const regexAllowed = (): boolean => {
    const p = prev();
    if (!p) return true;
    if (p.t === 'id') return REGEX_PRECEDING_KEYWORDS.has(p.v);
    if (p.t === 'p') return !['(', ')', ']', '}', '<'].includes(p.v) || p.v === '(';
    return false;
  };

  while (i < n) {
    const c = src[i]!;
    if (c === '\n') {
      line++;
      i++;
    } else if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') {
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop;
    } else if (c === '#' && src[i + 1] === '!' && i === 0) {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '"' || c === "'") {
      let text = '';
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          if (src[i + 1] === '\n') line++;
          text += src[i + 1] ?? '';
          i += 2;
        } else text += src[i++];
      }
      if (src[i] === c) i++;
      toks.push({ t: 'str', v: text, line });
    } else if (c === '`') {
      i++;
      template(line, '');
    } else if (c === '{') {
      stack.push('b');
      toks.push({ t: 'p', v: '{', line });
      i++;
    } else if (c === '}') {
      i++;
      if (stack.pop() === 't') template(line, '');
      else toks.push({ t: 'p', v: '}', line });
    } else if (c === '/' && regexAllowed()) {
      let k = i + 1;
      let inClass = false;
      let ok = false;
      while (k < n && src[k] !== '\n') {
        if (src[k] === '\\') k++;
        else if (src[k] === '[') inClass = true;
        else if (src[k] === ']') inClass = false;
        else if (src[k] === '/' && !inClass) {
          ok = true;
          break;
        }
        k++;
      }
      if (ok) {
        k++;
        while (k < n && isIdPart(src[k]!)) k++;
        toks.push({ t: 're', v: src.slice(i, k), line });
        i = k;
      } else {
        toks.push({ t: 'p', v: '/', line });
        i++;
      }
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let k = i + 1;
      while (k < n && /[\w.]/.test(src[k]!) && !(src[k] === '.' && src[k + 1] === '.')) k++;
      toks.push({ t: 'num', v: src.slice(i, k), line });
      i = k;
    } else if (isIdStart(c) || (c === '#' && isIdStart(src[i + 1] ?? ''))) {
      let k = i + 1;
      while (k < n && isIdPart(src[k]!)) k++;
      toks.push({ t: 'id', v: src.slice(i, k), line });
      i = k;
    } else {
      const m = PUNCT.find((p) => src.startsWith(p, i));
      // `?.` followed by a digit is a conditional (`a ?.5 : 1`), not optional chaining.
      const op = m === '?.' && /[0-9]/.test(src[i + 2] ?? '') ? '?' : (m ?? c);
      toks.push({ t: 'p', v: op, line });
      i += op.length;
    }
  }
  return toks;
}

interface Binding {
  module: string;
  /** `*` for a namespace, `default` for a default import, else the exported name. */
  imported: string;
}

/** The index of the token that closes the bracket opened at `open`, or -1. */
function matching(toks: Tok[], open: number): number {
  const o = toks[open]!.v;
  const close = o === '(' ? ')' : o === '[' ? ']' : '}';
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.t !== 'p') continue;
    if (t.v === o) depth++;
    else if (t.v === close && --depth === 0) return k;
  }
  return -1;
}

/** The index of the `(` that the `)` at `close` closes, or -1. */
function matchingOpen(toks: Tok[], close: number): number {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const t = toks[k]!;
    if (t.t !== 'p') continue;
    if (t.v === ')') depth++;
    else if (t.v === '(' && --depth === 0) return k;
  }
  return -1;
}

/** `require('m')` or `import('m')` starting at `k`, wrapped in any number of `await` and parentheses: the module and the index after it. */
function moduleExpr(toks: Tok[], k: number): { module: string; end: number } | undefined {
  let j = k;
  let parens = 0;
  while (toks[j] && ((toks[j]!.t === 'id' && toks[j]!.v === 'await') || (toks[j]!.t === 'p' && toks[j]!.v === '('))) {
    if (toks[j]!.v === '(') parens++;
    j++;
  }
  const f = toks[j];
  if (!f || f.t !== 'id' || (f.v !== 'require' && f.v !== 'import')) return undefined;
  if (toks[j + 1]?.v !== '(' || toks[j + 1]!.t !== 'p' || toks[j + 2]?.t !== 'str' || toks[j + 3]?.v !== ')') return undefined;
  let end = j + 4;
  while (parens > 0 && toks[end]?.v === ')') {
    end++;
    parens--;
  }
  return { module: toks[j + 2]!.v, end };
}

interface Spec {
  /** The exported name (or `default`). */
  imported: string;
  local: string;
  typeOnly: boolean;
}

/** Parses `{ a, b as c, type d }` starting at the `{` at `open`; returns the specifiers and the index after the `}`. */
function specifiers(toks: Tok[], open: number): { specs: Spec[]; end: number } {
  const close = matching(toks, open);
  const specs: Spec[] = [];
  let k = open + 1;
  while (k < close) {
    let typeOnly = false;
    if (toks[k]!.v === 'type' && toks[k + 1] && toks[k + 1]!.v !== ',' && toks[k + 1]!.v !== 'as' && k + 1 < close) {
      typeOnly = true;
      k++;
    }
    const imported = toks[k]!.v;
    let local = imported;
    k++;
    if (toks[k]?.v === 'as' && k < close) {
      local = toks[k + 1]!.v;
      k += 2;
    }
    specs.push({ imported, local, typeOnly });
    while (k < close && toks[k]!.v !== ',') k++;
    k++;
  }
  return { specs, end: close + 1 };
}

/** Checks one source file's text and returns every way around `secureRandomBytes` it contains, in line order. */
export function checkSource(src: string): Finding[] {
  const toks = tokenize(src);
  const lines = src.split('\n');
  const findings: Finding[] = [];
  const add = (rule: RuleName, tok: Tok, name: string): void => {
    findings.push({ rule, line: tok.line, name, text: (lines[tok.line - 1] ?? '').trim() });
  };

  const bindings = new Map<string, Binding>();
  /** Local names of `encrypt` imported from a NIP-44 module. */
  const encryptAliases = new Set<string>();
  /** Token indexes that are declarations (import clauses, destructuring patterns), not uses. */
  const declared = new Set<number>();
  const markRange = (from: number, to: number): void => {
    for (let k = from; k < to; k++) declared.add(k);
  };

  // Pass 1: imports, exports-from, `const x = require(...)`, destructuring patterns.
  const braceStack: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i]!;
    if (tk.t === 'p' && tk.v === '{') braceStack.push(i);
    if (tk.t === 'p' && tk.v === '}') {
      const open = braceStack.pop();
      if (open !== undefined) pattern(open, i);
      continue;
    }
    if (tk.t !== 'id') continue;
    const before = toks[i - 1];
    if (before && before.t === 'p' && (before.v === '.' || before.v === '?.')) continue;

    if (tk.v === 'import' && toks[i + 1] && toks[i + 1]!.v !== '(' && toks[i + 1]!.v !== '.') {
      let k = i + 1;
      if (toks[k]!.t === 'str') continue; // import 'm'
      const typeOnly = toks[k]!.v === 'type' && toks[k + 1] && toks[k + 1]!.v !== 'from' && toks[k + 1]!.v !== ',';
      if (typeOnly) k++;
      const clause: { local?: string; imported: string }[] = [];
      let specs: Spec[] = [];
      if (toks[k]!.t === 'id' && toks[k + 1]?.v === '=' && toks[k + 2]?.v === 'require') {
        // import x = require('m')
        const me = moduleExpr(toks, k + 2);
        if (me && !typeOnly) bindings.set(toks[k]!.v, { module: me.module, imported: '*' });
        markRange(i, me?.end ?? k + 3);
        continue;
      }
      if (toks[k]!.t === 'id' && toks[k]!.v !== 'from') {
        clause.push({ local: toks[k]!.v, imported: 'default' });
        k++;
        if (toks[k]?.v === ',') k++;
      }
      if (toks[k]?.v === '*' && toks[k + 1]?.v === 'as') {
        clause.push({ local: toks[k + 2]!.v, imported: '*' });
        k += 3;
      } else if (toks[k]?.v === '{') {
        const r = specifiers(toks, k);
        specs = r.specs;
        k = r.end;
      }
      if (toks[k]?.v !== 'from' || toks[k + 1]?.t !== 'str') continue;
      const module = toks[k + 1]!.v;
      markRange(i, k + 2);
      if (typeOnly) continue;
      for (const c of clause) bindings.set(c.local!, { module, imported: c.imported });
      for (const s of specs) {
        if (s.typeOnly) continue;
        bindings.set(s.local, { module, imported: s.imported });
        if (!isOwnModule(module) && IMPORT_NAMES.has(s.imported)) add('random-import', tk, s.imported);
      }
      continue;
    }

    if (tk.v === 'export' && toks[i + 1]?.t === 'p' && toks[i + 1]!.v === '{') {
      const r = specifiers(toks, i + 1);
      if (toks[r.end]?.v === 'from' && toks[r.end + 1]?.t === 'str') {
        const module = toks[r.end + 1]!.v;
        markRange(i, r.end + 2);
        if (!isOwnModule(module)) for (const s of r.specs) if (!s.typeOnly && IMPORT_NAMES.has(s.imported)) add('random-import', tk, s.imported);
      }
      continue;
    }

    // const x = require('m') / await import('m')
    if ((tk.v === 'const' || tk.v === 'let' || tk.v === 'var') && toks[i + 1]?.t === 'id' && toks[i + 2]?.v === '=') {
      const me = moduleExpr(toks, i + 3);
      if (me) bindings.set(toks[i + 1]!.v, { module: me.module, imported: '*' });
    }
  }

  /** The module that the value at `k` comes from, if it is `require('m')`, `import('m')` or a name bound to a module. */
  function source(k: number): string | undefined {
    const me = moduleExpr(toks, k);
    if (me) return me.module;
    let j = k;
    while (toks[j]?.v === '(' || toks[j]?.v === 'await') j++;
    const t = toks[j];
    if (t?.t === 'id') return bindings.get(t.v)?.module;
    return undefined;
  }

  /** A `{ ... }` that is a destructuring pattern (before `=`, or an arrow function's parameter) is checked for banned keys. */
  function pattern(open: number, close: number): void {
    const next = toks[close + 1];
    const before = toks[open - 1];
    if (before && before.t === 'p' && [':', '<', '|', '&', '?'].includes(before.v)) return; // a type annotation, not a pattern
    if (before && before.t === 'id' && !NOT_AN_OPERAND.has(before.v)) return; // `class X {`, `interface X {`, `foo {`
    let init: number | undefined;
    if (next?.t === 'p' && next.v === '=') init = close + 2;
    else if (next?.v === ')' && toks[close + 2]?.v === '=>' && (before?.v === '(' || before?.v === ',')) init = undefined;
    else return;
    markRange(open, close + 1);
    const module = init === undefined ? undefined : source(init);
    const initIsMath = init !== undefined && toks[init]?.v === 'Math' && toks[init + 1]?.v !== '.';
    const own = module !== undefined && isOwnModule(module);
    // Keys: an identifier or string right after `{` or `,`, followed by `,` `}` `:` or `=`.
    for (let k = open + 1; k < close; k++) {
      const t = toks[k]!;
      const p = toks[k - 1]!;
      const nx = toks[k + 1]!;
      if ((t.t !== 'id' && t.t !== 'str') || !(p.v === '{' || p.v === ',') || p.t !== 'p') continue;
      if (!(nx.t === 'p' && [',', '}', ':', '='].includes(nx.v))) continue;
      if (initIsMath && t.v === 'random') add('Math.random', t, 'random');
      else if (!own && MEMBER_NAMES.has(t.v)) add('random-destructure', t, t.v);
      if (module && NIP44_MODULE.test(module) && t.v === 'encrypt') encryptAliases.add(nx.v === ':' ? toks[k + 2]!.v : t.v);
    }
  }

  const nip44Roots = new Set<string>();
  for (const [local, b] of bindings) {
    if (NIP44_MODULE.test(b.module) && (b.imported === '*' || b.imported === 'default' || b.imported === 'v2')) nip44Roots.add(local);
    else if (NIP44_MODULE.test(b.module) && b.imported === 'encrypt') encryptAliases.add(local);
    else if (b.module === 'nostr-tools' && b.imported === 'nip44') nip44Roots.add(local);
  }

  /** The module of the value just before the `.`/`?.`/`[` at `k`, when it is a module, a module binding or `require()`/`import()`. */
  function receiverModule(k: number): string | undefined {
    let j = k - 1;
    while (toks[j]?.v === '!') j--;
    const t = toks[j];
    if (!t) return undefined;
    if (t.t === 'id') return bindings.get(t.v)?.module;
    if (t.t === 'p' && t.v === ')') {
      const open = matchingOpen(toks, j);
      if (open < 0) return undefined;
      // `(await import('m'))` or `require('m')` / `import('m')` itself
      const me = moduleExpr(toks, toks[open - 1]?.v === 'require' || toks[open - 1]?.v === 'import' ? open - 1 : open);
      return me && me.end === j + 1 ? me.module : undefined;
    }
    return undefined;
  }

  /** The identifiers of the member chain that ends just before `k` (`a.b.c` before the `.` at `k` gives `a`, `b`, `c`). */
  function chain(k: number): string[] {
    const names: string[] = [];
    let j = k - 1;
    for (;;) {
      while (toks[j]?.v === '!') j--;
      const t = toks[j];
      if (!t || t.t !== 'id') break;
      names.unshift(t.v);
      const d = toks[j - 1];
      if (d && d.t === 'p' && (d.v === '.' || d.v === '?.')) j -= 2;
      else break;
    }
    return names;
  }

  /** Checks the arguments of the call whose `(` is at `open`: false when there is no explicit nonce. */
  function hasNonce(open: number): boolean {
    const close = matching(toks, open);
    if (close < 0) return false;
    const args: Tok[][] = [[]];
    let depth = 0;
    for (let k = open + 1; k < close; k++) {
      const t = toks[k]!;
      if (t.t === 'p' && '([{'.includes(t.v) && t.v.length === 1) depth++;
      else if (t.t === 'p' && ')]}'.includes(t.v) && t.v.length === 1) depth--;
      if (depth === 0 && t.t === 'p' && t.v === ',') args.push([]);
      else args[args.length - 1]!.push(t);
    }
    if (args[args.length - 1]!.length === 0) args.pop(); // trailing comma
    if (args.some((a) => a[0]?.v === '...')) return false;
    if (args.length < 3) return false;
    const nonce = args[2]!;
    return !(nonce.length === 1 && (nonce[0]!.v === 'undefined' || nonce[0]!.v === 'null'));
  }

  // Pass 2: member accesses, bare uses of NIP-44 `encrypt`.
  for (let i = 0; i < toks.length; i++) {
    if (declared.has(i)) continue;
    const tk = toks[i]!;

    // member access: `.name`, `?.name`, `['name']`, `?.['name']`
    let name: string | undefined;
    let nameTok: Tok | undefined;
    let after = i + 1;
    const recv = i;
    if (tk.t === 'p' && (tk.v === '.' || tk.v === '?.') && toks[i + 1]?.t === 'id') {
      name = toks[i + 1]!.v;
      nameTok = toks[i + 1];
      after = i + 2;
    } else if (tk.t === 'p' && tk.v === '?.' && toks[i + 1]?.v === '[' && toks[i + 2]?.t === 'str' && toks[i + 3]?.v === ']') {
      name = toks[i + 2]!.v;
      nameTok = toks[i + 2];
      after = i + 4;
    } else if (tk.t === 'p' && tk.v === '[' && toks[i + 1]?.t === 'str' && toks[i + 2]?.v === ']') {
      const p = toks[i - 1];
      const isAccess = !!p && ((p.t === 'id' && !NOT_AN_OPERAND.has(p.v)) || (p.t === 'p' && (p.v === ')' || p.v === ']' || p.v === '!')) || p?.t === 'str');
      if (isAccess) {
        name = toks[i + 1]!.v;
        nameTok = toks[i + 1];
        after = i + 3;
      }
    }

    if (name !== undefined && nameTok) {
      const rm = receiverModule(recv);
      const own = rm !== undefined && isOwnModule(rm);
      const before = toks[recv - 1];
      if (name === 'random' && before?.t === 'id' && before.v === 'Math') add('Math.random', nameTok, 'Math.random');
      else if (MEMBER_NAMES.has(name) && !own) add('random-member', nameTok, name);
      else if (name === 'crypto' && before?.t === 'id' && GLOBAL_ROOTS.has(before.v) && !(toks[after]?.v === '.' && toks[after + 1]?.v === 'subtle'))
        add('global-crypto', nameTok, `${before.v}.crypto`);
      if (name === 'encrypt') {
        const c = chain(recv);
        const viaModule = rm !== undefined && NIP44_MODULE.test(rm);
        if (viaModule || c.some((x) => nip44Roots.has(x) || x === 'nip44')) {
          if (toks[after]?.v !== '(') add('nip44-no-nonce', nameTok, 'nip44.encrypt (not called, nonce cannot be checked)');
          else if (!hasNonce(after)) add('nip44-no-nonce', nameTok, 'nip44.encrypt');
        }
      }
      continue;
    }

    // `encrypt(...)` imported from a NIP-44 module
    if (tk.t === 'id' && encryptAliases.has(tk.v)) {
      const p = toks[i - 1];
      if (p && p.t === 'p' && (p.v === '.' || p.v === '?.')) continue;
      if (toks[i + 1]?.v === ':' && p && p.t === 'p' && (p.v === '{' || p.v === ',')) continue; // object key
      if (toks[i + 1]?.v !== '(') add('nip44-no-nonce', tk, 'nip44 encrypt (not called, nonce cannot be checked)');
      else if (!hasNonce(i + 1)) add('nip44-no-nonce', tk, 'nip44 encrypt');
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}
