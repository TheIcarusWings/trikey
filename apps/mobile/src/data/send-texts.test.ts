/**
 * Small things seen on a phone with 0.1.12 while paying: Review when every speed costs the same, the hardware wallet
 * screen sketch's amounts, and the device sheet's fee line after a long address.
 */
import { describe, expect, it } from 'vitest';
import { deviceAmount, deviceAmountUnit, deviceBtc, inDeviceUnit, promptDetailText } from './format';
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

describe("the device's unit (design review, finding 2)", () => {
  const address = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
  it('knows which devices show sats: a BitBox02 is asked for them, the others show BTC', () => {
    expect(deviceAmountUnit('bitbox02')).toBe('sats');
    for (const kind of ['ledger', 'trezor', 'jade-ble', 'qr', 'coldcard-nfc', 'simulated'] as const) expect(deviceAmountUnit(kind)).toBe('BTC');
    expect(deviceAmount(12_000, 'BTC')).toBe('0.00012000 BTC');
    expect(deviceAmount(12_000, 'sats')).toBe('12,000 sats');
  });
  it("writes a payment's prompt in the device's unit", () => {
    expect(inDeviceUnit(`Send 12000 sats to ${address}, fee 420 sats`, 'BTC')).toBe(`Send 0.00012000 BTC to ${address}, fee 0.00000420 BTC`);
    expect(inDeviceUnit(`Speed up the payment of 3000 sats to ${address}: network fee 190 -> 380 sats (190 more)`, 'BTC')).toBe(
      `Speed up the payment of 0.00003000 BTC to ${address}: network fee 0.00000190 -> 0.00000380 BTC (0.00000190 BTC more)`,
    );
    expect(inDeviceUnit(`Merge 3 coins into one of 50000 sats at this wallet's own address ${address}, fee 300 sats`, 'BTC')).toBe(
      `Merge 3 coins into one of 0.00050000 BTC at this wallet's own address ${address}, fee 0.00000300 BTC`,
    );
    // A device that shows sats: as written. And the fee still goes on its own line in the sheet.
    expect(inDeviceUnit(`Send 12000 sats to ${address}, fee 420 sats`, 'sats')).toBe(`Send 12000 sats to ${address}, fee 420 sats`);
    expect(promptDetailText(inDeviceUnit(`Send 12000 sats to ${address}, fee 420 sats`, 'BTC'))).toBe(`Send 0.00012000 BTC to ${address}\nFee 0.00000420 BTC`);
  });
});
