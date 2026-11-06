/** Settings > Support the project: hidden until an address is published, and the wording promises nothing back. */
import { describe, expect, it } from 'vitest';
import { DONATION_ABOUT, DONATION_ADDRESS, DONATION_WARNING, donationAddress } from '../src/lib/donation';
import { receiveUri } from '../src/lib/wallet';

describe('the donation address', () => {
  it('shows the published address: a mainnet P2WPKH bech32 address', () => {
    expect(donationAddress()).toBe(DONATION_ADDRESS);
    expect(DONATION_ADDRESS).toMatch(/^bc1q[02-9ac-hj-np-z]{38}$/);
  });

  it('hides the section while no address is published', () => {
    expect(donationAddress('')).toBeNull();
    expect(donationAddress('   ')).toBeNull();
  });

  it('shows a published address, trimmed, with a BIP 21 QR code', () => {
    const address = donationAddress(' bc1qexampleexampleexample ');
    expect(address).toBe('bc1qexampleexampleexample');
    expect(receiveUri(address!)).toBe('bitcoin:bc1qexampleexampleexample');
  });
});

describe('what the section says', () => {
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
