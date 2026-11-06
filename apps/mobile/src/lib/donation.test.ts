import { describe, expect, it } from 'vitest';
import { DONATION_ABOUT, DONATION_ADDRESS, DONATION_WARNING, donationAddress, donationUri } from './donation';

describe('the donation address', () => {
  it('shows the published address: a mainnet P2WPKH bech32 address', () => {
    expect(donationAddress()).toBe(DONATION_ADDRESS);
    expect(DONATION_ADDRESS).toMatch(/^bc1q[02-9ac-hj-np-z]{38}$/);
  });

  it('hides the row and screen while no address is published', () => {
    expect(donationAddress('')).toBeNull();
    expect(donationAddress('   ')).toBeNull();
  });

  it('shows a published address, trimmed', () => {
    expect(donationAddress(' bc1qexampleexampleexample ')).toBe('bc1qexampleexampleexample');
  });

  it('puts a BIP 21 URI in the QR code', () => {
    expect(donationUri('bc1qexample')).toBe('bitcoin:bc1qexample');
  });
});

describe('what the screen says', () => {
  const text = [...DONATION_ABOUT, DONATION_WARNING].join(' ');

  it('says what donations pay for, that they are public, and that nothing comes back', () => {
    expect(text).toMatch(/Google Play and Apple developer accounts/);
    expect(text).toMatch(/Donations are public/);
    expect(text).toMatch(/You get nothing in return/);
    expect(text).toMatch(/no guarantees/);
  });

  it('promises no reward', () => {
    expect(text).not.toMatch(/invest|return on|profit|reward|priority|perk|equity|share in/i);
  });
});
