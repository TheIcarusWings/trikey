/**
 * The preview unlock's state on this phone (preview-unlock.ts): the open challenge and until when preview is on, in
 * the key-value store. Read at start-up (boot.ts), so an unlock lasts across restarts until it runs out.
 */
import type { KeyValueStore } from '@trikey/wallet';
import { setPreviewUntil } from './features';
import { CHALLENGE_KEY, UNTIL_KEY, challengeCode, checkUnlock, type Challenge, type UnlockCheck } from './preview-unlock';

const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function loadPreview(kv: KeyValueStore, now = nowSeconds()): Promise<void> {
  const until = Number(await kv.get(UNTIL_KEY).catch(() => null));
  if (Number.isFinite(until) && until > now) setPreviewUntil(until);
  else {
    setPreviewUntil(0);
    await kv.remove(UNTIL_KEY).catch(() => {});
  }
}

export async function readChallenge(kv: KeyValueStore): Promise<Challenge | null> {
  try {
    const raw = await kv.get(CHALLENGE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<Challenge>;
    return typeof c.code === 'string' && /^[0-9a-f]{16}$/.test(c.code) && typeof c.issuedAt === 'number' ? { code: c.code, issuedAt: c.issuedAt } : null;
  } catch {
    return null;
  }
}

/** A new challenge from 8 secure random bytes, replacing any open one. */
export async function startChallenge(kv: KeyValueStore, random: (n: number) => Uint8Array, now = nowSeconds()): Promise<Challenge> {
  const challenge = { code: challengeCode(random(8)), issuedAt: now };
  await kv.set(CHALLENGE_KEY, JSON.stringify(challenge));
  return challenge;
}

/** Checks a scanned or pasted unlock; on success preview is on, and the challenge is used up. */
export async function finishUnlock(kv: KeyValueStore, raw: string, now = nowSeconds(), opts: { pubkey?: string } = {}): Promise<UnlockCheck> {
  const result = checkUnlock(raw, await readChallenge(kv), now, opts);
  if (result.ok) {
    await kv.set(UNTIL_KEY, String(result.until));
    await kv.remove(CHALLENGE_KEY);
    setPreviewUntil(result.until);
  }
  return result;
}

export async function turnOffPreview(kv: KeyValueStore): Promise<void> {
  await kv.remove(UNTIL_KEY);
  await kv.remove(CHALLENGE_KEY);
  setPreviewUntil(0);
}
