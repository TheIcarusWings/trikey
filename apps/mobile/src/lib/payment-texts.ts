/**
 * Words and numbers for the moving parts of a payment (docs/design/motion.md, sections 1 and 3), worked out from what the
 * wallet state already holds. Pure, so they can be tested.
 */
import type { AppToast, Sats, TxSigners } from '@/data/types';

/** One of the three keys, drawn as a small round mark. */
export type KeyName = 'phone' | 'guardian' | 'hardware';
/** off: not part of this (45%); waiting: asked, breathing; on: signed (green). */
export type KeyMarkState = 'off' | 'waiting' | 'on';
export type KeyMark = { key: KeyName; state: KeyMarkState };

/**
 * "Signed by this phone and your guardian", and the three key marks under it: the two that signed first, joined, and
 * the one that did not, dimmed. A payment the phone signed alone (Recovery Key mode's spending balance) shows its one
 * mark: the other two keys are not this wallet's to show.
 */
export function signedByView(signedBy: TxSigners | undefined, brand: string): { text: string; marks: KeyMark[]; linked: boolean } | null {
  switch (signedBy) {
    case 'phone+guardian':
      return { text: 'Signed by this phone and your guardian', marks: marks('phone', 'guardian', 'hardware'), linked: true };
    case 'phone+hardware':
      return { text: `Signed by this phone and your ${brand}`, marks: marks('phone', 'hardware', 'guardian'), linked: true };
    case 'hardware+guardian':
      return { text: `Signed by your ${brand} and your guardian`, marks: marks('hardware', 'guardian', 'phone'), linked: true };
    case 'phone':
      return { text: 'Signed by this phone', marks: [{ key: 'phone', state: 'on' }], linked: false };
    default:
      return null;
  }
}

function marks(a: KeyName, b: KeyName, off: KeyName): KeyMark[] {
  return [
    { key: a, state: 'on' },
    { key: b, state: 'on' },
    { key: off, state: 'off' },
  ];
}

/**
 * Review, while a payment is signed: the two steps the app can see. Busy (the phone signs, the guardian is asked), then
 * `paymentSending` (signed, on its way). There is no signal between "phone signed" and "guardian co-signed", so there is
 * no third step.
 */
export function signingView(signer: 'phone+guardian' | 'phone', sending: boolean): { text: string; marks: KeyMark[]; linked: boolean } {
  const state: KeyMarkState = sending ? 'on' : 'waiting';
  if (signer === 'phone') return { text: sending ? 'Signed. Sending…' : 'Signing…', marks: [{ key: 'phone', state }], linked: false };
  return {
    text: sending ? 'Signed. Sending…' : 'Signing with your guardian…',
    marks: [
      { key: 'phone', state },
      { key: 'guardian', state },
      { key: 'hardware', state: 'off' },
    ],
    linked: sending,
  };
}

/**
 * The line under the balance while the "Incoming …" toast is up: "+21,000 sats · unconfirmed". The toast carries only
 * its text, so the amount is read from it. A payment into Savings does not change this balance: no line.
 */
export function incomingLine(toast: AppToast | null | undefined): string | null {
  if (!toast || toast.kind !== 'incoming') return null;
  // `toastText` in src/data/real.ts writes it: "Incoming 21,000 sats · unconfirmed" ("… sats to Savings · …" for Savings).
  const m = /^Incoming ([\d,]+) sats · (unconfirmed|confirmed)$/.exec(toast.text);
  if (!m) return null;
  return `+${m[1]} sats · ${m[2]}`;
}

/**
 * The Sent screen's limit card: what was left before this payment and what is left now. The wallet state already counts
 * the payment (amount and fee) when Sent opens, so "before" is that plus the payment, never more than the limit. Only a
 * payment the phone and guardian signed counts toward the limit.
 */
export function limitBeforeAfter(input: { leftSats: Sats; limitSats: Sats; counted: boolean; amountSats: Sats; feeSats?: Sats }): { before: Sats; after: Sats } {
  const after = Math.max(0, input.leftSats);
  if (!input.counted) return { before: after, after };
  const before = Math.min(input.limitSats, after + input.amountSats + (input.feeSats ?? 0));
  return { before: Math.max(after, before), after };
}
