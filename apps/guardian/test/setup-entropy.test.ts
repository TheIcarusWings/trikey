/**
 * Entropy review 2026-10, M1: the phone's key-3 contribution `c` reaches the guardian over public relays,
 * encrypted to a nostr key from the guardian's own generator, so it does not help against a guardian
 * whose generator is predictable. The fix mixes inputs that never cross a relay into every new setup
 * seed (`trikey/guardian-seed/v1`, keystore.ts):
 *
 *     entropy = HMAC-SHA512(key = os, "trikey/guardian-seed/v1" || u32be(len) || browser || u32be(len) || extra)[0..32]
 *
 * `browser` comes with the web UI's setup or reset request, `extra` from TRIKEY_EXTRA_ENTROPY (Umbrel's
 * APP_SEED). Both optional, exactly 32 bytes when present.
 */
import { createHmac, randomFillSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hex } from '@scure/base';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { deterministicRandom, installRandomSource } from '@trikey/core/testing/random';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { loadConfig, parseExtraEntropy } from '../src/config.js';
import { RESET_CONFIRMATION, parseBrowserEntropy } from '../src/guardian.js';
import { SETUP_SEED_FORMAT, cosignerFromSeed, generateSeed, setupSeedEntropy, type SetupEntropy } from '../src/keystore.js';
import { GuardianRig } from './support/index.js';

const seq = (start: number) => Uint8Array.from({ length: 32 }, (_, i) => start + i);
const OS = seq(0x00);
const BROWSER = seq(0x20);
const EXTRA = seq(0x40);

/** The construction, independently, with node:crypto. */
function reference(os: Uint8Array, browser?: Uint8Array, extra?: Uint8Array): string {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const b = Buffer.from(browser ?? []);
  const e = Buffer.from(extra ?? []);
  const mac = createHmac('sha512', os).update(Buffer.concat([Buffer.from(SETUP_SEED_FORMAT), u32(b.length), b, u32(e.length), e])).digest();
  return mac.subarray(0, 32).toString('hex');
}

describe('trikey/guardian-seed/v1: the derivation', () => {
  it('known-answer vectors (fixed inputs), matching node:crypto', () => {
    const vectors: [SetupEntropy, string][] = [
      [{ browser: BROWSER, extra: EXTRA }, '0e425deb4dea22e972d641bcd66c0336bbc5699521089ed0c94eab2de6337359'],
      [{}, 'ce18beea5be9ea20b1a903037f0a1aeb8adcc53fac7875143939b735d68f81c9'],
      [{ browser: BROWSER }, '5d3e7aaa582234b8b1204eb11ddf0a31b232eaa2ff5fafb9c53bbbf740dd2bb3'],
      [{ extra: EXTRA }, '94a3a55757c9d0b466c279f66be2ec7f1fa1b6db188fb3561c7e1fe73788b93a'],
    ];
    for (const [inputs, want] of vectors) {
      const got = setupSeedEntropy(OS, inputs);
      expect(got).toHaveLength(32);
      expect(hex.encode(got)).toBe(want);
      expect(hex.encode(got)).toBe(reference(OS, inputs.browser, inputs.extra));
    }
    // The inputs are not modified.
    expect(OS).toEqual(seq(0x00));
    expect(BROWSER).toEqual(seq(0x20));
  });

  it('different inputs give different entropy, and each input keeps its own field', () => {
    const base = hex.encode(setupSeedEntropy(OS, { browser: BROWSER, extra: EXTRA }));
    const outs = new Set([
      base,
      hex.encode(setupSeedEntropy(OS, { browser: BROWSER, extra: seq(0x41) })),
      hex.encode(setupSeedEntropy(OS, { browser: seq(0x21), extra: EXTRA })),
      hex.encode(setupSeedEntropy(seq(0x01), { browser: BROWSER, extra: EXTRA })),
      // The same 32 bytes as the browser input or as the extra input are different seeds.
      hex.encode(setupSeedEntropy(OS, { browser: EXTRA })),
      hex.encode(setupSeedEntropy(OS, { extra: EXTRA })),
      hex.encode(setupSeedEntropy(OS, {})),
    ]);
    expect(outs.size).toBe(7);
    // Never the OS bytes themselves (the plain path before this change).
    expect(outs.has(hex.encode(OS))).toBe(false);
  });

  it('refuses inputs that are not exactly 32 bytes', () => {
    for (const bad of [new Uint8Array(0), new Uint8Array(31), new Uint8Array(33), new Uint8Array(64)]) {
      expect(() => setupSeedEntropy(OS, { browser: bad })).toThrow(/browser entropy must be exactly 32 bytes/);
      expect(() => setupSeedEntropy(OS, { extra: bad })).toThrow(/extra entropy must be exactly 32 bytes/);
      expect(() => setupSeedEntropy(bad)).toThrow(/OS entropy must be exactly 32 bytes/);
      expect(() => generateSeed({ browser: bad })).toThrow(/exactly 32 bytes/);
      expect(() => generateSeed({ extra: bad })).toThrow(/exactly 32 bytes/);
    }
    expect(() => setupSeedEntropy(OS, { browser: 'ab'.repeat(32) as unknown as Uint8Array })).toThrow(/32 bytes/);
  });
});

describe('trikey/guardian-seed/v1: generateSeed', () => {
  /** The seed of `generateSeed` from a known 32-byte OS draw, through the construction. */
  const seedFrom = (os: Uint8Array, inputs: SetupEntropy = {}) => mnemonicToSeedSync(entropyToMnemonic(setupSeedEntropy(os, inputs), wordlist));
  /**
   * `generateSeed` under a deterministic source (SHA-256 of `name` and a counter, one block per fill),
   * with the last 32-byte fill it made: its OS draw. The start-up health test (random-health.ts) draws its
   * own throwaway blocks first, so the OS draw is the last fill, not the first.
   */
  const seedUnder = (name: string, inputs: SetupEntropy) => {
    let n = 0;
    let last: Uint8Array | undefined;
    const src = installRandomSource((buf) => {
      for (let o = 0; o < buf.length; o += 32) buf.set(sha256(new TextEncoder().encode(`${name}/${n++}`)).slice(0, buf.length - o), o);
      if (buf.length === 32) last = Uint8Array.from(buf);
    });
    try {
      const seed = generateSeed(inputs);
      return { seed, os: last! };
    } finally {
      src.restore();
    }
  };

  it('is not the plain OS-entropy seed given the same OS bytes, and mixes every input it gets', () => {
    const seeds: Record<string, string> = {};
    for (const [name, inputs] of Object.entries({ none: {}, browser: { browser: BROWSER }, extra: { extra: EXTRA }, both: { browser: BROWSER, extra: EXTRA } } as Record<string, SetupEntropy>)) {
      const { seed, os } = seedUnder('m1', inputs);
      expect(seed).toHaveLength(64);
      seeds[name] = hex.encode(seed);
      expect(seeds[name]).toBe(hex.encode(seedFrom(os, inputs)));
      expect(seeds[name]).not.toBe(hex.encode(mnemonicToSeedSync(entropyToMnemonic(os, wordlist))));
    }
    expect(new Set(Object.values(seeds)).size).toBe(4);
    // The same source and inputs give the same seed; another source another seed.
    expect(hex.encode(seedUnder('m1', { browser: BROWSER, extra: EXTRA }).seed)).toBe(seeds['both']);
    expect(hex.encode(seedUnder('m2', { browser: BROWSER, extra: EXTRA }).seed)).not.toBe(seeds['both']);
  });

  it('attacker-chosen inputs do not make the seed predictable: it still varies with the OS draw', () => {
    const a = deterministicRandom('one');
    let s1: string;
    try {
      s1 = hex.encode(generateSeed({ browser: new Uint8Array(32), extra: new Uint8Array(32) }));
    } finally {
      a.restore();
    }
    const b = deterministicRandom('two');
    try {
      expect(hex.encode(generateSeed({ browser: new Uint8Array(32), extra: new Uint8Array(32) }))).not.toBe(s1);
    } finally {
      b.restore();
    }
  });

  it('a wrong-sized input is refused before anything is drawn', () => {
    let draws = 0;
    const src = installRandomSource((buf) => {
      draws++;
      randomFillSync(buf);
    });
    try {
      expect(() => generateSeed({ browser: new Uint8Array(16) })).toThrow(/32 bytes/);
      expect(draws).toBe(0);
    } finally {
      src.restore();
    }
  });
});

describe('TRIKEY_EXTRA_ENTROPY and the request field', () => {
  const APP_SEED = 'a1'.repeat(32);

  it('TRIKEY_EXTRA_ENTROPY: unset or empty is none, 64 hex characters are 32 bytes, anything else is hashed (never refuses to start)', () => {
    expect(parseExtraEntropy(undefined)).toBeUndefined();
    expect(parseExtraEntropy('')).toBeUndefined();
    expect(parseExtraEntropy('  ')).toBeUndefined();
    expect(hex.encode(parseExtraEntropy(APP_SEED)!)).toBe(APP_SEED);
    expect(hex.encode(parseExtraEntropy(` ${APP_SEED.toUpperCase()}\n`)!)).toBe(APP_SEED);
    const seen = new Set<string>();
    for (const other of ['a1'.repeat(31), 'a1'.repeat(33), 'zz'.repeat(32), `0x${'a1'.repeat(31)}`, 'a platform seed in another format']) {
      const bytes = parseExtraEntropy(other)!;
      expect(bytes).toHaveLength(32);
      expect(hex.encode(bytes)).toBe(hex.encode(sha256(new TextEncoder().encode(other))));
      seen.add(hex.encode(bytes));
    }
    expect(seen.size).toBe(5);
    expect(hex.encode(loadConfig({ TRIKEY_EXTRA_ENTROPY: APP_SEED }).extraEntropy!)).toBe(APP_SEED);
    expect(loadConfig({}).extraEntropy).toBeUndefined();
    expect(loadConfig({ TRIKEY_EXTRA_ENTROPY: 'abc' }).extraEntropy).toHaveLength(32);
  });

  it('the request field: absent is none, 64 lowercase hex characters are 32 bytes, anything else is refused', () => {
    expect(parseBrowserEntropy(undefined)).toBeUndefined();
    expect(hex.encode(parseBrowserEntropy('0f'.repeat(32)) as Uint8Array)).toBe('0f'.repeat(32));
    for (const bad of [null, '', 7, 'ab'.repeat(31), 'ab'.repeat(33), 'AB'.repeat(32), 'zz'.repeat(32), ['ab'.repeat(32)], { hex: 'ab'.repeat(32) }])
      expect(parseBrowserEntropy(bad)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The web UI's setup and reset over HTTP

/**
 * Records every 32-byte draw from the (real) OS source while `fn` runs: the setup seed's OS input is one
 * of them. Lets a test check which inputs the stored key 3 was made from without seeing the seed.
 */
async function recordingDraws<T>(fn: () => Promise<T>): Promise<{ result: T; draws: Uint8Array[] }> {
  const draws: Uint8Array[] = [];
  const src = installRandomSource((buf) => {
    randomFillSync(buf);
    if (buf.length === 32) draws.push(buf.slice());
  }, 'recording');
  try {
    return { result: await fn(), draws };
  } finally {
    src.restore();
  }
}

/** How many of `draws`, as the OS input with `inputs`, give the key 3 now on file. */
async function matching(rig: GuardianRig, draws: Uint8Array[], inputs: SetupEntropy | 'plain'): Promise<number> {
  const file = JSON.parse(await readFile(join(rig.dir, 'keystore.json'), 'utf8')) as { public: { xpub: string } };
  let n = 0;
  for (const os of draws) {
    const entropy = inputs === 'plain' ? os : setupSeedEntropy(os, inputs);
    const { pub, signer } = cosignerFromSeed(mnemonicToSeedSync(entropyToMnemonic(entropy, wordlist)), 'regtest');
    signer.wipe();
    if (pub.xpub === file.public.xpub) n++;
  }
  return n;
}

describe('the web UI setup and reset send entropy the guardian mixes in', { timeout: 60_000 }, () => {
  let rig: GuardianRig | undefined;
  afterEach(async () => {
    await rig?.stop();
    rig = undefined;
  });

  it('POST /api/setup accepts the browser entropy, refuses it malformed, and the new key 3 comes from it, the OS draw and TRIKEY_EXTRA_ENTROPY', async () => {
    rig = await GuardianRig.start({ http: true, setup: false, extraEntropy: EXTRA });
    const r0 = rig;
    const setup = (entropy: unknown) => r0.api('POST', '/setup', { passphrase: r0.passphrase, relays: r0.relayUrls, entropy }, { session: false });
    for (const bad of [null, '', 42, 'ab'.repeat(31), 'ab'.repeat(33), 'AB'.repeat(32), 'xy'.repeat(32), ['ab'.repeat(32)]]) {
      const r = await setup(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.code).toBe('invalid');
      expect(r.body.error.message).toMatch(/entropy/);
    }
    expect(rig.guardian.setupComplete).toBe(false);

    const browser = hex.encode(BROWSER);
    const { result, draws } = await recordingDraws(() => setup(browser));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ setupComplete: true, state: 'unlocked' });
    expect(await matching(rig, draws, { browser: BROWSER, extra: EXTRA })).toBe(1);
    // Not the plain OS path, nor the mix without either input.
    expect(await matching(rig, draws, 'plain')).toBe(0);
    expect(await matching(rig, draws, {})).toBe(0);
    expect(await matching(rig, draws, { browser: BROWSER })).toBe(0);
    expect(await matching(rig, draws, { extra: EXTRA })).toBe(0);

    // Neither input is logged or stored.
    const logs = rig.logLines.join('\n');
    const disk = await Promise.all(['keystore.json', 'service.json', 'guardian-state.json'].map((f) => readFile(join(r0.dir, f), 'utf8').catch(() => '')));
    for (const text of [logs, ...disk]) {
      expect(text).not.toContain(browser);
      expect(text).not.toContain(hex.encode(EXTRA));
    }
  });

  it('setup without a browser (not the web UI) still works, from the OS draw and TRIKEY_EXTRA_ENTROPY', async () => {
    rig = await GuardianRig.start({ setup: false, extraEntropy: EXTRA });
    const r0 = rig;
    const { result, draws } = await recordingDraws(() => r0.guardian.setup({ passphrase: r0.passphrase, relays: r0.relayUrls }));
    expect(result).toEqual({ ok: true });
    expect(await matching(rig, draws, { extra: EXTRA })).toBe(1);
    expect(await matching(rig, draws, 'plain')).toBe(0);
  });

  it('POST /api/reset: the same, for the new key 3 a reset makes', async () => {
    rig = await GuardianRig.start({ http: true, extraEntropy: EXTRA });
    const r0 = rig;
    const before = await readFile(join(rig.dir, 'keystore.json'), 'utf8');
    const reset = (entropy: unknown) => r0.api('POST', '/reset', { passphrase: r0.passphrase, confirm: RESET_CONFIRMATION, entropy });
    for (const bad of [null, 'ab'.repeat(31), 'AB'.repeat(32), 1]) {
      const r = await reset(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.code).toBe('invalid');
    }
    // Refused before anything changed.
    expect(await readFile(join(rig.dir, 'keystore.json'), 'utf8')).toBe(before);

    const browser = seq(0x60);
    const { result, draws } = await recordingDraws(() => reset(hex.encode(browser)));
    expect(result.status).toBe(200);
    expect(await readFile(join(rig.dir, 'keystore.json'), 'utf8')).not.toBe(before);
    expect(await matching(rig, draws, { browser, extra: EXTRA })).toBe(1);
    expect(await matching(rig, draws, 'plain')).toBe(0);
    expect(rig.logLines.join('\n')).not.toContain(hex.encode(browser));

    // A reset without a browser (another caller) still works.
    const again = await recordingDraws(() => r0.guardian.reset({ passphrase: r0.passphrase, confirm: RESET_CONFIRMATION }));
    expect(again.result.ok).toBe(true);
    expect(await matching(rig, again.draws, { extra: EXTRA })).toBe(1);
  });
});
