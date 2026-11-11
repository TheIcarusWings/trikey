/**
 * What the moving parts of a payment say and count (docs/design/motion.md, sections 1-3): who signed, the two signing
 * steps, the line under the balance while money arrives, the limit card's before and after, and the address ends.
 */
import { describe, expect, it } from 'vitest';
import { addressEnds, groupAddress } from '../data/format';
import { incomingLine, limitBeforeAfter, signedByView, signingView } from './payment-texts';
import { splitButtonClasses } from './utils';

describe('Sent: who signed', () => {
  it('names the two keys that signed and shows the third dimmed', () => {
    expect(signedByView('phone+guardian', 'Ledger')).toEqual({
      text: 'Signed by this phone and your guardian',
      marks: [
        { key: 'phone', state: 'on' },
        { key: 'guardian', state: 'on' },
        { key: 'hardware', state: 'off' },
      ],
      linked: true,
    });
    expect(signedByView('phone+hardware', 'Ledger')).toMatchObject({
      text: 'Signed by this phone and your Ledger',
      marks: [
        { key: 'phone', state: 'on' },
        { key: 'hardware', state: 'on' },
        { key: 'guardian', state: 'off' },
      ],
    });
    expect(signedByView('hardware+guardian', 'Trezor')?.text).toBe('Signed by your Trezor and your guardian');
  });

  it('shows one mark for a payment the phone signed alone, and nothing when it is not known', () => {
    expect(signedByView('phone', 'Ledger')).toEqual({ text: 'Signed by this phone', marks: [{ key: 'phone', state: 'on' }], linked: false });
    expect(signedByView(undefined, 'Ledger')).toBeNull();
  });
});

describe('Review: the two signing steps', () => {
  it('busy: the phone and the guardian are asked (breathing), the hardware wallet is not involved', () => {
    expect(signingView('phone+guardian', false)).toEqual({
      text: 'Signing with your guardian…',
      marks: [
        { key: 'phone', state: 'waiting' },
        { key: 'guardian', state: 'waiting' },
        { key: 'hardware', state: 'off' },
      ],
      linked: false,
    });
  });

  it('paymentSending: both signed, joined, "Signed. Sending…"; there is no third step', () => {
    const v = signingView('phone+guardian', true);
    expect(v.text).toBe('Signed. Sending…');
    expect(v.linked).toBe(true);
    expect(v.marks.map((m) => m.state)).toEqual(['on', 'on', 'off']);
  });

  it('the phone alone (Recovery Key mode)', () => {
    expect(signingView('phone', false)).toEqual({ text: 'Signing…', marks: [{ key: 'phone', state: 'waiting' }], linked: false });
    expect(signingView('phone', true).text).toBe('Signed. Sending…');
  });
});

describe('Home: the line under the balance while money arrives', () => {
  const toast = (text: string) => ({ id: 't', kind: 'incoming' as const, text });

  it('reads the amount from the toast', () => {
    expect(incomingLine(toast('Incoming 21,000 sats · unconfirmed'))).toBe('+21,000 sats · unconfirmed');
    expect(incomingLine(toast('Incoming 2,500,000 sats · confirmed'))).toBe('+2,500,000 sats · confirmed');
  });

  it('says nothing for Savings (not this balance), no toast, or a note it does not recognise', () => {
    expect(incomingLine(toast('Incoming 21,000 sats to Savings · unconfirmed'))).toBeNull();
    expect(incomingLine(null)).toBeNull();
    expect(incomingLine(undefined)).toBeNull();
    expect(incomingLine(toast('Something else'))).toBeNull();
  });
});

describe('Sent: the limit card', () => {
  it('counts the payment and its fee back for "before", never above the limit', () => {
    expect(limitBeforeAfter({ leftSats: 154_620, limitSats: 200_000, counted: true, amountSats: 25_000, feeSats: 380 })).toEqual({ before: 180_000, after: 154_620 });
    expect(limitBeforeAfter({ leftSats: 190_000, limitSats: 200_000, counted: true, amountSats: 25_000, feeSats: 380 })).toEqual({ before: 200_000, after: 190_000 });
    expect(limitBeforeAfter({ leftSats: 100, limitSats: 200_000, counted: true, amountSats: 900 })).toEqual({ before: 1_000, after: 100 });
  });

  it('does not move for a payment that did not count toward the limit', () => {
    expect(limitBeforeAfter({ leftSats: 150_000, limitSats: 200_000, counted: false, amountSats: 25_000, feeSats: 380 })).toEqual({ before: 150_000, after: 150_000 });
  });
});

describe('Approve on the hardware wallet: the address ends', () => {
  it('cuts the grouped address after its first four and before its last four characters', () => {
    const a = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    const ends = addressEnds(a);
    expect(ends.head).toBe('bc1q');
    expect(ends.tail).toBe('f3 t4');
    expect(ends.head + ends.middle + ends.tail).toBe(groupAddress(a));
  });

  it('keeps a short address whole', () => {
    expect(addressEnds('bc1qabcd')).toEqual({ head: 'bc1q abcd', middle: '', tail: '' });
    const ends = addressEnds('bc1qabcdef12');
    expect([ends.head, ends.middle, ends.tail]).toEqual(['bc1q', ' abcd ', 'ef12']);
  });
});

describe('Press feedback: a button inside its place', () => {
  it('keeps padding, height and radius on the button, and the rest on the view that places it', () => {
    expect(splitButtonClasses('mt-1 self-center px-5')).toEqual({ place: 'mt-1 self-center', own: 'px-5' });
    expect(splitButtonClasses('flex-1 self-auto')).toEqual({ place: 'flex-1 self-auto', own: '' });
    expect(splitButtonClasses('rounded-[10px]')).toEqual({ place: '', own: 'rounded-[10px]' });
    expect(splitButtonClasses(undefined)).toEqual({ place: '', own: '' });
  });
});
