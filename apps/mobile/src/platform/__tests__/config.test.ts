import { describe, expect, it } from 'vitest';
import { googleOAuthClientId, passkeyRpId } from '../config';

describe('googleOAuthClientId', () => {
  it('is null when unset or blank, so Google Drive reports itself unavailable', () => {
    expect(googleOAuthClientId(undefined)).toBeNull();
    expect(googleOAuthClientId('')).toBeNull();
    expect(googleOAuthClientId('   ')).toBeNull();
  });

  it('rejects placeholders that are not a real client id', () => {
    expect(googleOAuthClientId('YOUR_CLIENT_ID_HERE')).toBeNull();
    expect(googleOAuthClientId('123456789-abc.example.com')).toBeNull();
  });

  it('accepts a Google client id', () => {
    expect(googleOAuthClientId(' 123456789012-abcdef0123456789.apps.googleusercontent.com ')).toBe(
      '123456789012-abcdef0123456789.apps.googleusercontent.com',
    );
  });
});

describe('passkeyRpId', () => {
  it('is null when unset: there is no default domain', () => {
    expect(passkeyRpId(undefined)).toBeNull();
    expect(passkeyRpId('')).toBeNull();
  });

  it('accepts a domain and normalizes case', () => {
    expect(passkeyRpId('Wallet.Example.com')).toBe('wallet.example.com');
    expect(passkeyRpId('example.org')).toBe('example.org');
  });

  it('rejects URLs, ports, paths, bare hosts and IPs', () => {
    for (const bad of ['https://example.com', 'example.com:443', 'example.com/path', 'localhost', '10.0.0.1', '-a.com', 'a..com', 'exa mple.com']) {
      expect(passkeyRpId(bad), bad).toBeNull();
    }
  });
});
