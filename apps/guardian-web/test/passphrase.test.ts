/**
 * "Change passphrase" (Settings > Passphrase): the rules the page checks before sending (the setup's own, shared with
 * the first-run page; apps/guardian/test/keystore-change.test.ts holds them to the guardian's `checkPassphrase`), the
 * request it sends, its error words, and what it says after the change (DESIGN.md, "Changing the passphrase").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { createHttpApi } from '../src/api/http';
import { createMockApi } from '../src/api/mock';
import {
  CHANGE_PASSPHRASE_INTRO,
  MIN_PASSPHRASE,
  PASSPHRASE_CHANGED_NOTES,
  changePassphraseError,
  newPassphraseErrors,
  passphraseLength,
  samePassphrase,
} from '../src/lib/passphrase';

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

let sent: Sent[];
let answer: { status: number; body: unknown };

beforeEach(() => {
  sent = [];
  answer = { status: 200, body: { authenticated: true, setupComplete: true, state: 'unlocked' } };
  vi.stubGlobal('window', { dispatchEvent: () => true });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ method: String(init.method), url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const OLD = 'correct horse battery staple';
const NEW = 'a brand new passphrase, long enough';

describe('the new passphrase rules', () => {
  it("are setup's: at least 12 characters, typed twice the same", () => {
    expect(MIN_PASSPHRASE).toBe(12);
    expect(newPassphraseErrors({ passphrase: NEW, confirm: NEW })).toEqual({});
    expect(newPassphraseErrors({ passphrase: 'short', confirm: 'short' }).passphrase).toMatch(/at least 12 characters/);
    expect(newPassphraseErrors({ passphrase: NEW, confirm: `${NEW}!` }).confirm).toMatch(/don't match/);
    expect(newPassphraseErrors({ passphrase: 'x'.repeat(1025), confirm: 'x'.repeat(1025) }).passphrase).toMatch(/at most 1024/);
  });

  it('count characters as the guardian does (NFKC code points), not UTF-16 units', () => {
    // 12 emoji are 24 UTF-16 units but 12 characters: enough. 11 are not, whatever their length in units.
    expect(passphraseLength('🔑'.repeat(12))).toBe(12);
    expect(newPassphraseErrors({ passphrase: '🔑'.repeat(12), confirm: '🔑'.repeat(12) })).toEqual({});
    expect(newPassphraseErrors({ passphrase: '🔑'.repeat(11), confirm: '🔑'.repeat(11) }).passphrase).toBeDefined();
    // A decomposed "é" is one character to the guardian.
    expect(passphraseLength('café')).toBe(4);
  });

  it('for a change: the current passphrase is needed, and the new one must differ from it (NFKC-equal counts as the same)', () => {
    expect(newPassphraseErrors({ current: '', passphrase: NEW, confirm: NEW }).current).toMatch(/current passphrase/);
    expect(newPassphraseErrors({ current: OLD, passphrase: NEW, confirm: NEW })).toEqual({});
    expect(newPassphraseErrors({ current: OLD, passphrase: OLD, confirm: OLD }).passphrase).toMatch(/other than the current one/);
    expect(samePassphrase('café café café x', 'café café café x')).toBe(true);
    expect(newPassphraseErrors({ current: 'café café café x', passphrase: 'café café café x', confirm: 'café café café x' }).passphrase).toBeDefined();
  });
});

describe('the request', () => {
  it('POST /api/passphrase with the current and the new passphrase only (no browser entropy: no new key is made)', async () => {
    const api = createHttpApi();
    const status = await api.changePassphrase({ passphrase: OLD, newPassphrase: NEW });
    expect(status).toMatchObject({ authenticated: true, state: 'unlocked' });
    expect(sent).toEqual([{ method: 'POST', url: '/api/passphrase', body: { passphrase: OLD, newPassphrase: NEW } }]);
  });

  it("a wrong current passphrase is the guardian's 401 bad_passphrase, not a sign-out", async () => {
    const signedOut = vi.fn(() => true);
    vi.stubGlobal('window', { dispatchEvent: signedOut });
    answer = { status: 401, body: { error: { code: 'bad_passphrase', message: 'That is not the current passphrase.' } } };
    const e = await createHttpApi().changePassphrase({ passphrase: 'wrong wrong wrong', newPassphrase: NEW }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('bad_passphrase');
    expect(signedOut).not.toHaveBeenCalled();
  });

  it('the demo API does the same checks', async () => {
    const api = createMockApi();
    await expect(api.changePassphrase({ passphrase: 'wrong', newPassphrase: NEW })).rejects.toMatchObject({ code: 'bad_passphrase' });
    await expect(api.changePassphrase({ passphrase: OLD, newPassphrase: 'short' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(api.changePassphrase({ passphrase: OLD, newPassphrase: OLD })).rejects.toMatchObject({ code: 'same_passphrase' });
    await expect(api.changePassphrase({ passphrase: OLD, newPassphrase: NEW })).resolves.toMatchObject({ state: 'unlocked' });
    expect((await api.listActivity()).find((a) => a.summary === 'Passphrase changed')).toBeDefined();
  });
});

describe('what the page says', () => {
  it('the errors in plain words', () => {
    expect(changePassphraseError(new ApiError('bad_passphrase', 'x', 401))).toBe("That isn't the current passphrase.");
    expect(changePassphraseError(new ApiError('rate_limited', 'x', 429, 8))).toMatch(/Wait 8 seconds/);
    expect(changePassphraseError(new ApiError('same_passphrase', 'x', 400))).toMatch(/other than the current one/);
    expect(changePassphraseError(new ApiError('locked', 'x', 409))).toMatch(/Unlock it first/);
    expect(changePassphraseError(new ApiError('invalid', 'New passphrase: use at least 12 characters.', 400))).toBe('New passphrase: use at least 12 characters.');
    expect(changePassphraseError(undefined)).toMatch(/Could not change/);
  });

  it('before: the same key 3, the slots kept, other browsers signed out', () => {
    expect(CHANGE_PASSPHRASE_INTRO).toMatch(/same key 3/);
    expect(CHANGE_PASSPHRASE_INTRO).toMatch(/hardware wallet unlock stay/);
    expect(CHANGE_PASSPHRASE_INTRO).toMatch(/signed out/);
  });

  it('after: old copies no longer work, recovery does not use it, old backups still open with the old one', () => {
    const all = PASSPHRASE_CHANGED_NOTES.join('\n');
    // Older copies: the password manager, an older app that sent it unsealed.
    expect(all).toMatch(/old passphrase no longer unlocks/);
    expect(all).toMatch(/password manager/);
    expect(all).toMatch(/older than 0\.1\.17/);
    // Recovery: the recovery code, backup file, sheet and Replace guardian do not use it.
    expect(all).toMatch(/recovery does not use this passphrase/i);
    expect(all).toMatch(/Replace guardian needs only your phone and hardware wallet/);
    // Backups made before still open with the old passphrase (and hold the same key 3).
    expect(all).toMatch(/still opens with the old passphrase/);
    expect(all).toMatch(/same key 3/);
    // No link anywhere, like every Trikey text.
    expect(all).not.toMatch(/https?:|www\./);
  });
});
