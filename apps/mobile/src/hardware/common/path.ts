import { HardwareError } from '../errors';

export const HARDENED = 0x80000000;

/** `m/48'/1'/0'/2'` (also `h` or `H` for hardened, and a missing `m/`) as BIP32 child numbers. */
export function parsePath(path: string): number[] {
  const trimmed = path.trim();
  if (trimmed === 'm' || trimmed === 'M') return [];
  const body = trimmed.replace(/^[mM]\//, '');
  if (body === '') throw new HardwareError('invalid-request', `Invalid derivation path: "${path}"`);
  return body.split('/').map((part) => {
    const m = /^(\d{1,10})(['hH]?)$/.exec(part);
    if (!m) throw new HardwareError('invalid-request', `Invalid derivation path: "${path}"`);
    const n = Number(m[1]);
    const index = m[2] ? n + HARDENED : n;
    if (n >= HARDENED || index > 0xffffffff) throw new HardwareError('invalid-request', `Derivation index out of range in "${path}"`);
    return index;
  });
}

/** `[2147483696, 2147483649]` as `m/48'/1'`. Pass `'h'` for the `h` spelling. */
export function formatPath(path: readonly number[], hardened: "'" | 'h' = "'"): string {
  return ['m', ...path.map((n) => (n >= HARDENED ? `${n - HARDENED}${hardened}` : String(n)))].join('/');
}

export function isHardened(n: number): boolean {
  return n >= HARDENED;
}

/** The SLIP-44 coin type of a purpose'/coin'/... path, or undefined if the path has no hardened second step. */
export function coinTypeOf(path: readonly number[]): number | undefined {
  const c = path[1];
  return c !== undefined && c >= HARDENED ? c - HARDENED : undefined;
}

/** The descriptor spelling of a path ("48h/1h/0h/2h") from core, as numbers. */
export function parseOriginPath(origin: string): number[] {
  return origin === '' ? [] : parsePath(`m/${origin}`);
}
