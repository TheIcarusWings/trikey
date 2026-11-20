import { describe, expect, it } from 'vitest';
import { buildChannel } from './build-channel';

describe('buildChannel', () => {
  it('follows EXPO_PUBLIC_TRIKEY_CHANNEL when it is set', () => {
    expect(buildChannel('release', true)).toBe('release');
    expect(buildChannel('test', false)).toBe('test');
  });

  it('unset or unknown: a development build is a test build, anything else a release build', () => {
    expect(buildChannel(undefined, true)).toBe('test');
    expect(buildChannel(undefined, false)).toBe('release');
    expect(buildChannel('', false)).toBe('release');
    expect(buildChannel('beta', false)).toBe('release');
  });
});
