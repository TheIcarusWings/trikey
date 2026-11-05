/**
 * Small things seen on a phone with 0.1.12 while paying: Review when every speed costs the same, the hardware wallet
 * screen sketch's amounts, and the device sheet's fee line after a long address.
 */
import { describe, expect, it } from 'vitest';
import { deviceBtc, promptDetailText } from './format';
import { SAME_FEE_NOTE, sameFeeEverySpeed } from './rules';

describe('Review: every speed at the same fee', () => {
  it('tells when all quoted speeds cost the same', () => {
    expect(sameFeeEverySpeed({ fast: 190, normal: 190, slow: 190 })).toBe(true);
    expect(sameFeeEverySpeed({ fast: 380, normal: 190, slow: 190 })).toBe(false);
    // One that could not be quoted does not count; one alone says nothing.
    expect(sameFeeEverySpeed({ fast: 190, slow: 190 })).toBe(true);
    expect(sameFeeEverySpeed({ normal: 190 })).toBe(false);
    expect(sameFeeEverySpeed({})).toBe(false);
    expect(SAME_FEE_NOTE).toMatch(/All speeds cost the same right now/);
  });
});

describe('the hardware wallet screen sketch', () => {
  it('shows the amount and the fee with the same eight decimals', () => {
    expect(deviceBtc(3_000)).toBe('0.00003000');
    expect(deviceBtc(190)).toBe('0.00000190');
    expect(deviceBtc(100_000)).toBe('0.00100000');
    expect(deviceBtc(123_456_789)).toBe('1.23456789');
  });
});

describe("the device sheet's text", () => {
  const address = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
  it('puts the fee on its own line, never a comma or a colon first', () => {
    expect(promptDetailText(`Send 3000 sats to ${address}, fee 190 sats`)).toBe(`Send 3000 sats to ${address}\nFee 190 sats`);
    expect(promptDetailText(`Speed up the payment of 3000 sats to ${address}: network fee 190 -> 380 sats (190 more)`)).toBe(
      `Speed up the payment of 3000 sats to ${address}\nNetwork fee 190 -> 380 sats (190 more)`,
    );
    expect(promptDetailText('Approve the new wallet')).toBe('Approve the new wallet');
  });
});
