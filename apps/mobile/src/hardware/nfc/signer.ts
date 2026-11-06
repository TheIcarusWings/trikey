/**
 * `HardwareSigner` for a Coldcard (Mk4 or Q) over NFC (kind `coldcard-nfc`). Nothing stays connected: every call asks
 * the owner to open a menu on the Coldcard and hold the phone to it, through an `NfcBridge`; what goes over the air is
 * in `coldcard.ts`. The checks are the QR signer's: the key export must be the device's, a signed payment must carry a
 * signature of the Coldcard on every input it owns, and a signed text must verify against the key at the path, derived
 * from the account key the Coldcard exported, before anything uses it.
 */
import { HDKey } from '@scure/bip32';
import {
  nfcMessageProblem,
  nfcModelInfo,
  type HardwareDeviceInfo,
  type HardwareSigner,
  type HardwareWalletPolicy,
  type NfcModel,
  type SignMessageContext,
} from '@trikey/wallet';
import { getNetwork, type NetworkName } from '@trikey/core';
import { HardwareError } from '../errors';
import { HARDENED, coinTypeOf, formatPath, parsePath } from '../common/path';
import {
  assertDeviceSignedAll,
  decodePsbtBase64,
  encodePsbtBase64,
  inputsForFingerprint,
  mergePartialSignatures,
  parsePsbtBytes,
  signaturesFromRawTransaction,
  signaturesFromSignedPsbt,
} from '../common/psbt';
import { assertChainIndex, assertNetworkFamily, findKeyIndex, parseWalletPolicy, walletScriptsAt } from '../common/wallet';
import { xpubFamily } from '../common/xpub';
import { findExportedKey, type ExportedKey } from '../qr/export';
import { checkMessageAnswer, messageAddresses } from '../qr/message';
import { coldcardMultisigConfig } from '../qr/registration';
import type { NfcBridge } from './bridge';
import { keyExportFromNdef, messageAnswerFromNdef, messageRequest, psbtRequest, signedFromNdef, walletRequest } from './coldcard';

export interface NfcSignerOptions {
  network: NetworkName;
  bridge: NfcBridge;
  /** Which Coldcard, for the words (undefined: "Coldcard", with both models' keys). */
  model?: NfcModel;
  /** Account keys already read from the device's export while connecting. */
  knownKeys?: ExportedKey[];
}

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

/** What the text is for, in a sentence for the NFC screen. */
const PURPOSE_NOTE: Record<NonNullable<SignMessageContext['purpose']>, string> = {
  pairing: 'This text proves to your guardian that this Coldcard holds the key that approves changes for this wallet. It names the wallet and your guardian’s key. It moves no money.',
  approval: 'This text approves the change you asked for. What it changes is written out in it (for rules: the limit, delay, fee cap and number of contacts): check it on the Coldcard. It is valid for a short time only.',
  'recovery-access': 'This text lets this phone ask your guardian for the wallet, so it can start a recovery. It names your guardian and this phone, and expires soon. It moves no money.',
  notes: 'This text makes the key that encrypts your notes on the guardian. It moves no money and changes no rule.',
  unlock: 'This text opens your guardian after it restarted, without the passphrase. It moves no money and changes no rule.',
};

/** Where the phone touches the Coldcard. `docs/nfc-coldcard.md`: Mk4 under the 8 key; Q behind the screen. */
const WHERE: Record<NfcModel | 'any', string> = {
  'coldcard-mk4': 'Hold the back of the phone flat on the Coldcard Mk4’s keypad, over the 8 key, and keep it still until the phone says it is done.',
  'coldcard-q': 'Hold the back of the phone flat on the Coldcard Q’s screen and keep it still until the phone says it is done.',
  any: 'Hold the back of the phone flat on the Coldcard (a Mk4: over the 8 key; a Q: on the screen) and keep it still until the phone says it is done.',
};

const NFC_ON = 'NFC must be on in the Coldcard’s Settings › Hardware On/Off › NFC Sharing.';

export class NfcSigner implements HardwareSigner {
  private readonly keys: ExportedKey[];

  constructor(
    readonly info: HardwareDeviceInfo,
    private readonly opts: NfcSignerOptions,
  ) {
    this.keys = [...(opts.knownKeys ?? [])];
  }

  private get name(): string {
    return nfcModelInfo(this.opts.model).name;
  }

  private get where(): string {
    return WHERE[this.opts.model ?? 'any'];
  }

  private get shareKey(): string {
    return nfcModelInfo(this.opts.model).shareKey;
  }

  private checkWallet(wallet: HardwareWalletPolicy) {
    const parsed = parseWalletPolicy(wallet, 'coldcard-nfc');
    assertNetworkFamily(parsed, this.opts.network, 'coldcard-nfc');
    if (findKeyIndex(parsed, this.info.fingerprint) < 0)
      throw new HardwareError('invalid-request', `This ${this.name}'s key is not part of the wallet. Is it the same Coldcard (and passphrase) that was set up as key 1?`, { kind: 'coldcard-nfc' });
    return parsed;
  }

  async getXpub(path: string): Promise<string> {
    const numbers = parsePath(path);
    if (numbers.length === 0) throw new HardwareError('invalid-request', 'Asking for the master key is not supported.', { kind: 'coldcard-nfc' });
    const known = this.keys.find((k) => same(k.path, numbers));
    if (known) return known.xpub;
    const exp = await this.opts.bridge.read({
      purpose: 'device-key',
      title: `Read the key ${formatPath(numbers)}`,
      instructions: `Trikey needs the public key ${formatPath(numbers)} of your ${this.name}.`,
      steps: exportSteps(numbers, this.shareKey),
      notes: [this.where, NFC_ON],
      actionLabel: 'Read from the Coldcard',
      alert: 'Hold your phone to the Coldcard.',
      accept: (records) => {
        const e = keyExportFromNdef(records);
        if (e.fingerprint !== this.info.fingerprint)
          throw new HardwareError('invalid-response', `That key is from a different device (master fingerprint ${e.fingerprint}, not ${this.info.fingerprint}).`, { kind: 'coldcard-nfc' });
        findExportedKey(e, numbers);
        return e;
      },
    });
    for (const k of exp.keys) if (!this.keys.some((x) => same(x.path, k.path))) this.keys.push(k);
    const key = findExportedKey(exp, numbers);
    const coinType = coinTypeOf(numbers);
    if (coinType !== undefined && xpubFamily(key.xpub) !== (coinType === 0 ? 'main' : 'test'))
      throw new HardwareError('invalid-response', 'The Coldcard exported a key for the wrong network.', { kind: 'coldcard-nfc' });
    return key.xpub;
  }

  async registerWallet(wallet: HardwareWalletPolicy): Promise<{ hmac?: string }> {
    const parsed = this.checkWallet(wallet);
    const message = walletRequest(coldcardMultisigConfig(parsed));
    await this.opts.bridge.write({
      purpose: 'wallet',
      title: `Add the wallet to your ${this.name}`,
      instructions: `The Coldcard keeps the 2-of-3 wallet "${wallet.name}" so it can co-sign its payments. Send it over NFC.`,
      steps: [
        'On the Coldcard open Settings › Multisig Wallets › Import, and choose NFC (the Coldcard then waits, showing the NFC animation).',
        'Tap "Send to the Coldcard" below and hold the phone to it.',
      ],
      notes: [this.where, NFC_ON],
      actionLabel: 'Send to the Coldcard',
      alert: 'Hold your phone to the Coldcard to send the wallet.',
      message,
    });
    await this.opts.bridge.show({
      purpose: 'wallet',
      title: 'Approve the wallet on the Coldcard',
      instructions: `About 3 seconds after you lift the phone, the Coldcard shows the wallet it read. Check the name "${wallet.name}", "2 of 3" and the three keys, then approve it.`,
      continueLabel: 'I approved it',
    });
    return {};
  }

  async displayAddress(wallet: HardwareWalletPolicy, chain: 0 | 1, index: number): Promise<string> {
    assertChainIndex(chain, index);
    const parsed = this.checkWallet(wallet);
    // Nothing asks a Coldcard over NFC for an address: Trikey derives it, and the owner compares it on the device.
    const { address } = walletScriptsAt(parsed, chain, index, this.opts.network);
    await this.opts.bridge.show({
      purpose: 'address',
      title: 'Compare the address on your Coldcard',
      instructions: `On the Coldcard open Address Explorer, pick the wallet "${wallet.name}", and check that its ${chain === 0 ? 'receive' : 'change'} address ${index} is exactly this address.`,
      detail: address,
      continueLabel: 'The addresses match',
    });
    return address;
  }

  async signPsbt(psbtBase64: string, wallet: HardwareWalletPolicy): Promise<string> {
    const original = decodePsbtBase64(psbtBase64);
    this.checkWallet(wallet);
    const ours = inputsForFingerprint(parsePsbtBytes(original), this.info.fingerprint);
    if (ours.length === 0) throw new HardwareError('invalid-request', `None of the inputs belong to this ${this.name}.`, { kind: 'coldcard-nfc' });
    const message = psbtRequest(original, ours.length);

    await this.opts.bridge.write({
      purpose: 'psbt',
      title: `Sign on your ${this.name}`,
      instructions: 'Send the payment to the Coldcard over NFC, check it there and sign it, then read the signed payment back.',
      steps: [
        'On the Coldcard open Advanced/Tools › NFC Tools › Sign PSBT. It waits, showing the NFC animation.',
        'Tap "Send to the Coldcard" below and hold the phone to it. Lift the phone when it says it is done.',
        'About 3 seconds later the Coldcard shows the payment: check the amount and the address, and approve it.',
      ],
      notes: [this.where, NFC_ON],
      actionLabel: 'Send to the Coldcard',
      alert: 'Hold your phone to the Coldcard to send the payment.',
      message,
    });

    const signatures = await this.opts.bridge.read({
      purpose: 'signed-psbt',
      title: 'Read the signed payment',
      instructions: 'Once you approved the payment, the Coldcard shares the signed payment over NFC (it shows the NFC animation again).',
      steps: ['Tap "Read from the Coldcard" below and hold the phone to it.', 'When the phone has it, press OK or X on the Coldcard to stop sharing.'],
      notes: [this.where],
      actionLabel: 'Read from the Coldcard',
      alert: 'Hold your phone to the Coldcard to read the signed payment.',
      // Another payment, or a damaged one, becomes a hint: the owner can read again.
      accept: (records) => {
        const signed = signedFromNdef(records);
        const sigs = signed.kind === 'psbt' ? signaturesFromSignedPsbt(original, signed.bytes) : signaturesFromRawTransaction(original, signed.bytes);
        if (sigs.length === 0) throw new HardwareError('invalid-response', `The ${this.name} did not add any signature. Approve the payment on the Coldcard, then read it again.`, { kind: 'coldcard-nfc' });
        return sigs;
      },
    });
    const { psbt } = mergePartialSignatures(original, signatures);
    assertDeviceSignedAll(psbt, this.info.fingerprint);
    return encodePsbtBase64(psbt);
  }

  /** The compressed pubkey at `path`, derived from the account key the Coldcard exported (read now if not known yet). */
  private async pubkeyAt(path: number[]): Promise<Uint8Array> {
    let hardened = 0;
    while (hardened < path.length && path[hardened]! >= HARDENED) hardened++;
    if (hardened === 0 || hardened === path.length) throw new HardwareError('invalid-request', `Trikey can only check a message key below an account key, not ${formatPath(path)}.`, { kind: 'coldcard-nfc' });
    const xpub = await this.getXpub(formatPath(path.slice(0, hardened)));
    const key = HDKey.fromExtendedKey(xpub, getNetwork(this.opts.network).bip32).derive(`m/${path.slice(hardened).join('/')}`);
    return key.publicKey!;
  }

  /**
   * BIP 137 over NFC: writes `signmessage <path> ascii:<text>` to the Coldcard (NFC Tools › Sign Message), reads the
   * armored answer back and checks the text, the address and the signature against the key at `path`.
   */
  async signMessage(path: string, message: string, context: SignMessageContext = {}): Promise<string> {
    const problem = nfcMessageProblem(message);
    if (problem) throw new HardwareError('invalid-request', problem, { kind: 'coldcard-nfc' });
    const numbers = parsePath(path);
    const request = messageRequest(path, message);
    const pubkey = await this.pubkeyAt(numbers);
    const shownPath = formatPath(numbers);
    const { p2pkh } = messageAddresses(pubkey, this.opts.network);
    const round = context.round && context.round.of > 1 ? context.round : undefined;
    const notes = [
      ...(context.purpose ? [PURPOSE_NOTE[context.purpose]] : []),
      ...(round
        ? [
            round.n === 1
              ? `Your Coldcard will show the same text ${round.of === 2 ? 'twice' : `${round.of} times`}. Sign it each time: Trikey checks that it signs the same way every time, so the same key can be made again later.`
              : `Round ${round.n} of ${round.of}: the same text again. Sign it once more.`,
          ]
        : []),
      `The Coldcard shows the text before it signs: check that it is exactly the text above. It also shows the path ${shownPath} and this address for the key: ${p2pkh}`,
      this.where,
      NFC_ON,
    ];

    await this.opts.bridge.write({
      purpose: 'message',
      title: round ? `Sign on your ${this.name} (${round.n} of ${round.of})` : `Sign on your ${this.name}`,
      instructions: `Your ${this.name} signs the short text below with the key ${shownPath}, the key that approves changes for this wallet.`,
      detail: message,
      steps: [
        'On the Coldcard open Advanced/Tools › NFC Tools › Sign Message. It waits, showing the NFC animation.',
        'Tap "Send to the Coldcard" below and hold the phone to it. Lift the phone when it says it is done.',
        'About 3 seconds later the Coldcard shows the text, the path and the address: check them and press OK to sign.',
      ],
      notes,
      actionLabel: 'Send to the Coldcard',
      alert: 'Hold your phone to the Coldcard to send the text.',
      message: request,
    });

    return this.opts.bridge.read({
      purpose: 'signed-message',
      title: 'Read the signature',
      instructions: 'Once you signed, the Coldcard shares the signature over NFC (it shows the NFC animation again).',
      steps: ['Tap "Read from the Coldcard" below and hold the phone to it.', 'When the phone has it, press OK or X on the Coldcard to stop sharing.'],
      notes: [this.where],
      actionLabel: 'Read from the Coldcard',
      alert: 'Hold your phone to the Coldcard to read the signature.',
      // A wrong key or another text becomes a hint: the owner can sign again and read the new one.
      accept: (records) => checkMessageAnswer(messageAnswerFromNdef(records), { text: message, pubkey, network: this.opts.network, path, label: this.name }),
    });
  }

  async close(): Promise<void> {
    // Nothing stays connected. If an NFC sheet is still up, the host closes it.
  }
}

/** The steps to share the multisig key export of the account `path` names. */
export function exportSteps(path: readonly number[], shareKey: string): string[] {
  const account = path[2] !== undefined && path[2] >= HARDENED ? path[2] - HARDENED : 0;
  return [
    'On the Coldcard open Settings › Multisig Wallets › Export XPUB, and press OK.',
    `Enter account number ${account} and press OK.`,
    `When it asks how to export, ${shareKey} to share over NFC (the NFC animation shows).`,
    'Tap "Read from the Coldcard" below and hold the phone to it.',
  ];
}
