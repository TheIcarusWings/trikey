import { describe, expect, it } from 'vitest';
import { ANDROID_HAPTIC, IOS_HAPTIC, type HapticKind } from './haptic-kinds';

const KINDS: HapticKind[] = ['tick', 'light', 'success', 'warning', 'error'];

describe("Trikey's five haptics", () => {
  it('are the ones on the Haptics board', () => {
    expect(KINDS.map((k) => IOS_HAPTIC[k])).toEqual([
      { ios: 'selection' },
      { ios: 'impact', style: 'light' },
      { ios: 'notification', type: 'success' },
      { ios: 'notification', type: 'warning' },
      { ios: 'notification', type: 'error' },
    ]);
    expect(KINDS.map((k) => ANDROID_HAPTIC[k])).toEqual(['keyboard-tap', 'context-click', 'confirm', 'long-press', 'reject']);
  });

  it('feel different from each other on Android', () => {
    expect(new Set(Object.values(ANDROID_HAPTIC)).size).toBe(KINDS.length);
  });
});
