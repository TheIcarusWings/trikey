/**
 * Copying a secret (the backup's recovery code) with the protections the phone offers, and taking it back off the
 * clipboard after a minute. The owner asked for it after typing a code copied from a screenshot by text recognition,
 * which put look-alike Cyrillic letters into it; a screenshot is the worse copy (photo galleries sync and keep them).
 *
 * - Android: the clip is marked sensitive (`ClipDescription.EXTRA_IS_SENSITIVE`, the same key read before Android 13):
 *   the system's copy preview hides it, and keyboards that keep a clipboard history (Gboard) leave it out.
 * - iOS: `localOnly`, so Universal Clipboard doesn't hand it to the person's other Apple devices, and an expiry, after
 *   which iOS removes it itself.
 * - Both: after the minute (and when the screen is left), the clipboard is emptied if it still holds this code. Anything
 *   the person copied since is left alone.
 *
 * What it cannot do: an app reading the clipboard during that minute sees the code, as for anything copied. The screen
 * says so and keeps paper as the advice.
 */
import type { SetStringOptions } from 'expo-clipboard';

export const SENSITIVE_COPY_SECONDS = 60;

/** The clipboard calls this needs: expo-clipboard's (the screen passes it), or a fake in tests. */
export interface ClipboardLike {
  setStringAsync(text: string, options?: SetStringOptions): Promise<boolean>;
  getStringAsync(): Promise<string>;
}

/** A copy that can be taken back: `clear()` empties the clipboard if it still holds the text. */
export interface SensitiveCopy {
  clear(): Promise<void>;
}

export async function copySensitive(
  text: string,
  opts: { clipboard: ClipboardLike; seconds?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => () => void },
): Promise<SensitiveCopy> {
  const clipboard = opts.clipboard;
  const seconds = opts.seconds ?? SENSITIVE_COPY_SECONDS;
  const now = opts.now ?? Date.now;
  await clipboard.setStringAsync(text, {
    android: { isSensitive: true },
    ios: { localOnly: true, expiresAt: new Date(now() + seconds * 1000) },
  });
  let done = false;
  const clear = async () => {
    if (done) return;
    done = true;
    cancel();
    try {
      // Only this code: what the person copied since stays. Android may refuse to read while the app is in the
      // background; then nothing is touched, and the sensitive flag (iOS: the expiry) still holds.
      if ((await clipboard.getStringAsync()) === text) await clipboard.setStringAsync('');
    } catch {
      // nothing to do
    }
  };
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  const cancel = setTimer(() => void clear(), seconds * 1000);
  return { clear };
}
