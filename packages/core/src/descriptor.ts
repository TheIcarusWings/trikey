/**
 * Output descriptor helpers (BIP380 checksum, BIP389 multipath keys) for the
 * single script template Trikey uses: wsh(sortedmulti(2, K1, K2, K3)).
 */

const INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function polymod(symbols: number[]): bigint {
  let chk = 1n;
  for (const value of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) chk ^= GENERATOR[i];
  }
  return chk;
}

export function descriptorChecksum(desc: string): string {
  const symbols: number[] = [];
  let groups: number[] = [];
  for (const c of desc) {
    const v = INPUT_CHARSET.indexOf(c);
    if (v < 0) throw new Error(`invalid descriptor character: ${c}`);
    symbols.push(v & 31);
    groups.push(v >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
      groups = [];
    }
  }
  if (groups.length === 1) symbols.push(groups[0]);
  else if (groups.length === 2) symbols.push(groups[0] * 3 + groups[1]);
  const chk = polymod([...symbols, 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  let out = '';
  for (let i = 0; i < 8; i++) out += CHECKSUM_CHARSET[Number((chk >> BigInt(5 * (7 - i))) & 31n)];
  return out;
}

export function addChecksum(desc: string): string {
  return `${desc}#${descriptorChecksum(desc)}`;
}

/** Strips and verifies a trailing `#checksum` if present. */
export function stripChecksum(desc: string): string {
  const i = desc.indexOf('#');
  if (i < 0) return desc;
  const body = desc.slice(0, i);
  if (descriptorChecksum(body) !== desc.slice(i + 1)) throw new Error('descriptor checksum mismatch');
  return body;
}

/** A key with origin info, e.g. `[d34db33f/48h/1h/0h/2h]tpub...`. */
export interface KeyExpression {
  /** Master key fingerprint, 8 hex chars. */
  fingerprint: string;
  /** Origin path below the master, e.g. "48h/1h/0h/2h"; empty for a depth-0 key. */
  originPath: string;
  xpub: string;
}

export function formatKey(k: KeyExpression, suffix: string): string {
  const origin = k.originPath ? `${k.fingerprint}/${k.originPath}` : k.fingerprint;
  return `[${origin}]${k.xpub}${suffix}`;
}

/**
 * Builds the wallet descriptor. `multipath` yields one BIP389 `<0;1>` descriptor;
 * otherwise `chain` selects the receive (0) or change (1) descriptor for tools
 * that predate BIP389.
 */
export function sortedMultiDescriptor(keys: KeyExpression[], opts: { chain?: 0 | 1 } = {}): string {
  const suffix = opts.chain === undefined ? '/<0;1>/*' : `/${opts.chain}/*`;
  return addChecksum(`wsh(sortedmulti(2,${keys.map((k) => formatKey(k, suffix)).join(',')}))`);
}

const KEY_RE = /^\[([0-9a-fA-F]{8})((?:\/\d+['h]?)*)\]([1-9A-HJ-NP-Za-km-z]+)\/(?:<0;1>|[01])\/\*$/;

export function parseSortedMultiDescriptor(desc: string): KeyExpression[] {
  const body = stripChecksum(desc.trim());
  const m = /^wsh\(sortedmulti\(2,(.+)\)\)$/.exec(body);
  if (!m) throw new Error('only wsh(sortedmulti(2,...)) descriptors are supported');
  const keys = m[1].split(',').map((s) => {
    const k = KEY_RE.exec(s);
    if (!k) throw new Error(`unsupported key expression: ${s}`);
    return {
      fingerprint: k[1].toLowerCase(),
      originPath: k[2].replace(/^\//, '').replace(/'/g, 'h'),
      xpub: k[3],
    };
  });
  if (keys.length !== 3) throw new Error('expected exactly 3 keys');
  return keys;
}
