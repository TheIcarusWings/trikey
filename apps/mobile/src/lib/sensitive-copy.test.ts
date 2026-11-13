import { describe, expect, it } from 'vitest';
import { copySensitive, type ClipboardLike } from './sensitive-copy';

function fakeClipboard() {
  const calls: { text: string; options?: unknown }[] = [];
  let value = '';
  const cb: ClipboardLike & { value: () => string; calls: typeof calls; set: (v: string) => void } = {
    async setStringAsync(text, options) {
      calls.push({ text, options });
      value = text;
      return true;
    },
    async getStringAsync() {
      return value;
    },
    value: () => value,
    calls,
    set: (v) => (value = v),
  };
  return cb;
}

function manualTimer() {
  let fire: (() => void) | undefined;
  return {
    setTimer: (fn: () => void) => {
      fire = fn;
      return () => (fire = undefined);
    },
    fire: () => fire?.(),
  };
}

describe('copySensitive', () => {
  it('copies with the protections: sensitive on Android, local-only with an expiry a minute away on iOS', async () => {
    const cb = fakeClipboard();
    await copySensitive('ABCDE-FGHJK', { clipboard: cb, now: () => 1_000_000, setTimer: manualTimer().setTimer });
    expect(cb.value()).toBe('ABCDE-FGHJK');
    expect(cb.calls[0]!.options).toEqual({ android: { isSensitive: true }, ios: { localOnly: true, expiresAt: new Date(1_060_000) } });
  });

  it('empties the clipboard after the minute if it still holds the code', async () => {
    const cb = fakeClipboard();
    const t = manualTimer();
    await copySensitive('ABCDE-FGHJK', { clipboard: cb, setTimer: t.setTimer });
    t.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(cb.value()).toBe('');
  });

  it('leaves what the person copied since', async () => {
    const cb = fakeClipboard();
    const t = manualTimer();
    const copy = await copySensitive('ABCDE-FGHJK', { clipboard: cb, setTimer: t.setTimer });
    cb.set('something else');
    await copy.clear();
    expect(cb.value()).toBe('something else');
  });

  it('can be taken back early (leaving the screen), once', async () => {
    const cb = fakeClipboard();
    const t = manualTimer();
    const copy = await copySensitive('ABCDE-FGHJK', { clipboard: cb, setTimer: t.setTimer });
    await copy.clear();
    expect(cb.value()).toBe('');
    cb.set('later');
    t.fire(); // the timer was cancelled: nothing happens
    await copy.clear();
    expect(cb.value()).toBe('later');
  });

  it('does nothing when the clipboard cannot be read (Android, app in the background)', async () => {
    const cb = fakeClipboard();
    const copy = await copySensitive('ABCDE-FGHJK', { clipboard: cb, setTimer: manualTimer().setTimer });
    cb.getStringAsync = async () => {
      throw new Error('not in focus');
    };
    await copy.clear();
    expect(cb.value()).toBe('ABCDE-FGHJK');
  });
});
