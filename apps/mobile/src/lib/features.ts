/**
 * Which features the app offers, by stage (docs/design/public-release.md, the owner's decision of 2026-11-21):
 *
 * - **test**: only in Trikey Test (a test build, `build-channel.ts`), with Demo, Simulator and regtest.
 * - **preview**: also in the public app, hidden until the owner unlocks preview on that phone with a signature from the
 *   publisher key (preview-unlock.ts), for 24 hours. For trying a feature on a real wallet before everyone gets it.
 * - **public**: in the public app for everyone.
 *
 * A feature moves test → preview → public by a pull request that changes its `stage` and adds its `evidence`;
 * `features.test.ts` refuses a preview or public feature without evidence, and a public hardware wallet without a
 * test on a real device. That test is the promotion check.
 *
 * Hidden means "can't be turned on", never "can't be read": a wallet that already uses a feature (Savings set up in
 * Trikey Test, then restored here, say) keeps showing and spending it, so a stage never strands money. Recovery
 * (restore, lost phone, lost hardware wallet, Replace guardian) is never gated, and neither is a hardware wallet a
 * wallet already uses. The guardian is one build for everyone: its own features are listed in the design doc, not here.
 */
import type { QrModel } from '@trikey/wallet';
import { BUILD_CHANNEL, type BuildChannel } from './build-channel';

export type Stage = 'test' | 'preview' | 'public';

export interface Feature {
  title: string;
  stage: Stage;
  /** Where it was shown to work: an issue or test report on a real device, a test file, a release. */
  evidence: string[];
  /** A hardware wallet: going public needs a test on a real device among the evidence (an issue or a report). */
  hardware?: true;
}

const QR = (name: string): Feature => ({ title: `${name} (QR)`, stage: 'preview', evidence: ['Recorded and simulated answers: packages/wallet/test'], hardware: true });

export const FEATURES = {
  // Hardware wallets, offered when a wallet is made. The owner's decision: Ledger, Trezor and one QR device for the
  // first public release.
  ledger: {
    title: 'Ledger (Bluetooth)',
    stage: 'public',
    evidence: ['Core path tested by the owner on a Ledger: docs/beta-checklist.md, section 3; https://github.com/TheIcarusWings/trikey/issues/273'],
    hardware: true,
  },
  trezor: { title: 'Trezor', stage: 'preview', evidence: ['Set up and address check on a Trezor Safe 7 by the owner (0.1.30); tests 2 and 3 open: https://github.com/TheIcarusWings/trikey/issues/274'], hardware: true },
  bitbox02: { title: 'BitBox02 (USB-C, Bluetooth)', stage: 'test', evidence: [], hardware: true },
  'jade-ble': { title: 'Jade by Bluetooth', stage: 'test', evidence: [], hardware: true },
  'coldcard-nfc': { title: 'Coldcard by NFC', stage: 'test', evidence: [], hardware: true },
  'qr:coldcard-q': QR('Coldcard Q'),
  'qr:coldcard-mk4': QR('Coldcard Mk4'),
  'qr:jade': QR('Jade'),
  'qr:keystone-3': QR('Keystone 3'),
  'qr:passport-prime': QR('Passport Prime'),
  'qr:passport': QR('Passport'),
  'qr:seedsigner': QR('SeedSigner'),
  'qr:krux': QR('Krux'),
  'qr:specter-diy': QR('Specter DIY'),
  'qr:other': { title: 'Another QR device', stage: 'test', evidence: [], hardware: true },

  // Wallet features: what is turned on or set up.
  'recovery-key-mode': { title: 'Recovery Key mode (no home server)', stage: 'test', evidence: [] },
  savings: { title: 'Savings', stage: 'test', evidence: [] },
  'silent-payments': { title: 'Receiving silent payments', stage: 'test', evidence: [] },
  'family-hosting': { title: "A key on someone else's guardian (invites)", stage: 'test', evidence: [] },
  'several-wallets': { title: 'Several wallets in one app', stage: 'test', evidence: [] },
} as const satisfies Record<string, Feature>;

export type FeatureId = keyof typeof FEATURES;

/** The hardware wallet features, by the connect list's kinds. */
export const HARDWARE_FEATURE = {
  ledger: 'ledger',
  trezor: 'trezor',
  bitbox02: 'bitbox02',
  'jade-ble': 'jade-ble',
  'coldcard-nfc': 'coldcard-nfc',
} as const satisfies Record<string, FeatureId>;

export const qrFeature = (model: QrModel): FeatureId => `qr:${model}`;

/** Until when (Unix seconds) preview is on for this phone: set by the owner's signed unlock (preview-unlock.ts). */
let previewUntil = 0;
const listeners = new Set<() => void>();

export function setPreviewUntil(until: number): void {
  previewUntil = until;
  for (const l of listeners) l();
}

export function previewOnUntil(): number | null {
  return previewUntil > Date.now() / 1000 ? previewUntil : null;
}

export function onPreviewChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a feature of `stage` is offered: everything in a test build; public, and preview once unlocked, otherwise. */
export function stageOn(stage: Stage, channel: BuildChannel, preview: boolean): boolean {
  if (channel === 'test') return true;
  return stage === 'public' || (stage === 'preview' && preview);
}

export function featureOn(id: FeatureId, channel: BuildChannel = BUILD_CHANNEL, preview: boolean = previewOnUntil() !== null): boolean {
  return stageOn(FEATURES[id].stage, channel, preview);
}

/** A QR model is offered when its feature is; "Scan a QR code" when any model is. */
export function qrModelOn(model: QrModel, channel?: BuildChannel, preview?: boolean): boolean {
  return featureOn(qrFeature(model), channel, preview);
}
