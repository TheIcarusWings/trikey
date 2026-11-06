/**
 * `HardwareSigner` for air-gapped devices (Coldcard Q, Jade, Keystone, Passport, SeedSigner...). Nothing is
 * connected: every call shows QR codes for the device to scan, and/or scans the QR codes the device shows back. The
 * screens are somebody else's job; this class only talks to a `QrBridge`.
 */
import { HDKey } from '@scure/bip32';
import {
  QR_MODEL_INFO,
  messageProblemFor,
  qrMessageMethod,
  qrModelInfo,
  type HardwareDeviceInfo,
  type HardwareKind,
  type HardwareSigner,
  type HardwareWalletPolicy,
  type QrModel,
  type QrModelInfo,
  type SignMessageContext,
} from '@trikey/wallet';
import { getNetwork, type NetworkName } from '@trikey/core';
import { HardwareError, HardwareNotSupportedError } from '../errors';
import { assertChainIndex, assertNetworkFamily, findKeyIndex, parseWalletPolicy, walletScriptsAt } from '../common/wallet';
import { HARDENED, coinTypeOf, formatPath, parsePath } from '../common/path';
import { xpubFamily } from '../common/xpub';
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
import type { QrBridge } from './bridge';
import { encodeBbqr } from './bbqr';
import { findExportedKey, parseDeviceExport, type ExportedKey } from './export';
import { checkMessageAnswer, messageAddresses, parseMessageAnswer, signMessageRequest } from './message';
import { signedFromPayload } from './payload';
import { coldcardMultisigConfig } from './registration';
import { acceptFrames } from './scan';
import { baseName, parseSignedFile, sdFormatOf, sdRequestFile } from './sd-message';
import type { QrFormat } from './types';
import { encodePsbtUr } from './ur';

export type QrRegistrationFormat = 'coldcard' | 'descriptor';

export interface QrSignerOptions {
  network: NetworkName;
  bridge: QrBridge;
  format: QrFormat;
  /** How `registerWallet` shows the wallet. */
  registration: QrRegistrationFormat;
  /** Name for the instructions: "Coldcard", "Jade", or "signing device". */
  label: string;
  /** Which device it is (@trikey/wallet qr-devices.ts): whether it signs Trikey's texts, and the steps to word. Default `other`. */
  model?: QrModel;
  /** Account keys already read from the device's export while connecting. */
  knownKeys?: ExportedKey[];
  /** Used for plain frame length (UR) and QR density (BBQr). */
  maxUrFragmentLength?: number;
  maxBbqrVersion?: number;
}

/** QR models that cannot sign Trikey's texts (by QR code or from a microSD card). They are named in the error so the UI can say so. */
export const QR_DEVICES_WITHOUT_MESSAGE_SIGNING: readonly string[] = Object.values(QR_MODEL_INFO)
  .filter((i) => !i.qr || !i.signsMessages)
  .map((i) => i.name);

/** What the text the device signs is for, in a sentence for the QR screen. */
const PURPOSE_NOTE: Record<NonNullable<SignMessageContext['purpose']>, string> = {
  pairing: 'This text proves to your guardian that this hardware wallet holds the key that approves changes for this wallet. It names the wallet and your guardian’s key. It moves no money.',
  approval: 'This text approves the change you asked for. What it changes is written out in it (for rules: the limit, delay, fee cap and number of contacts): check it on the device. It is valid for a short time only.',
  'recovery-access': 'This text lets this phone ask your guardian for the wallet, so it can start a recovery. It names your guardian and this phone, and expires soon. It moves no money.',
  notes: 'This text makes the key that encrypts your notes on the guardian. It moves no money and changes no rule.',
  unlock: 'This text opens your guardian after it restarted, without the passphrase. It moves no money and changes no rule.',
};

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

export class QrSigner implements HardwareSigner {
  private readonly keys: ExportedKey[];

  constructor(
    readonly info: HardwareDeviceInfo,
    private readonly opts: QrSignerOptions,
  ) {
    this.keys = [...(opts.knownKeys ?? [])];
  }

  private get kind(): HardwareKind {
    return this.info.kind;
  }

  private checkWallet(wallet: HardwareWalletPolicy) {
    const parsed = parseWalletPolicy(wallet, this.kind);
    assertNetworkFamily(parsed, this.opts.network, this.kind);
    if (findKeyIndex(parsed, this.info.fingerprint) < 0)
      throw new HardwareError('invalid-request', `This ${this.opts.label}'s key is not part of the wallet. Is it the same device (and passphrase) that was set up as key 1?`, { kind: this.kind });
    return parsed;
  }

  async getXpub(path: string): Promise<string> {
    const numbers = parsePath(path);
    if (numbers.length === 0) throw new HardwareError('invalid-request', 'Asking for the master key is not supported.', { kind: this.kind });
    const known = this.keys.find((k) => same(k.path, numbers));
    if (known) return known.xpub;
    const shown = formatPath(numbers);
    const exp = await this.opts.bridge.scan({
      purpose: 'device-key',
      title: `Scan the key ${shown}`,
      instructions: `On your ${this.opts.label}, show the public key for ${shown} as a QR code (the multisig or account export), then point this camera at it.`,
      accept: acceptFrames(parseDeviceExport),
    });
    if (exp.fingerprint !== this.info.fingerprint)
      throw new HardwareError('invalid-response', `That key is from a different device (master fingerprint ${exp.fingerprint}, not ${this.info.fingerprint}).`, { kind: this.kind });
    for (const k of exp.keys) if (!this.keys.some((x) => same(x.path, k.path))) this.keys.push(k);
    const key = findExportedKey(exp, numbers);
    const coinType = coinTypeOf(numbers);
    if (coinType !== undefined && xpubFamily(key.xpub) !== (coinType === 0 ? 'main' : 'test'))
      throw new HardwareError('invalid-response', 'The device exported a key for the wrong network.', { kind: this.kind });
    return key.xpub;
  }

  async registerWallet(wallet: HardwareWalletPolicy): Promise<{ hmac?: string }> {
    const parsed = this.checkWallet(wallet);
    const coldcard = this.opts.registration === 'coldcard';
    const frames = coldcard ? encodeBbqr(new TextEncoder().encode(coldcardMultisigConfig(parsed)), 'U', { maxVersion: this.opts.maxBbqrVersion }) : [wallet.descriptor];
    await this.opts.bridge.show({
      purpose: 'wallet',
      title: `Add the wallet to your ${this.opts.label}`,
      instructions: coldcard
        ? 'On the Coldcard open Settings > Multisig Wallets > Import from QR, scan this code, check the name, the keys and "2 of 3" on its screen, then approve.'
        : `On your ${this.opts.label} choose to add a multisig wallet from a QR code, scan this code, check the keys and "2 of 3" on its screen, then approve.`,
      frames,
      continueLabel: 'I have added it',
    });
    return {};
  }

  async displayAddress(wallet: HardwareWalletPolicy, chain: 0 | 1, index: number): Promise<string> {
    assertChainIndex(chain, index);
    const parsed = this.checkWallet(wallet);
    // An air-gapped device cannot be asked for the address: we derive it from the descriptor and the user compares it with the device.
    const { address } = walletScriptsAt(parsed, chain, index, this.opts.network);
    await this.opts.bridge.show({
      purpose: 'address',
      title: 'Compare the address on your device',
      instructions: `On your ${this.opts.label}, open the wallet's ${chain === 0 ? 'receive' : 'change'} address ${index} and check that it is exactly this address.`,
      frames: [address],
      detail: address,
      continueLabel: 'The addresses match',
    });
    return address;
  }

  async signPsbt(psbtBase64: string, wallet: HardwareWalletPolicy): Promise<string> {
    const original = decodePsbtBase64(psbtBase64);
    this.checkWallet(wallet);
    if (inputsForFingerprint(parsePsbtBytes(original), this.info.fingerprint).length === 0)
      throw new HardwareError('invalid-request', `None of the inputs belong to this ${this.opts.label}.`, { kind: this.kind });

    const frames = this.opts.format === 'bbqr' ? encodeBbqr(original, 'P', { maxVersion: this.opts.maxBbqrVersion }) : encodePsbtUr(original, { maxFragmentLength: this.opts.maxUrFragmentLength });
    await this.opts.bridge.show({
      purpose: 'psbt',
      title: `Sign on your ${this.opts.label}`,
      instructions: `Scan this code with your ${this.opts.label}. Check the amount and the address on its screen, sign, then scan the signed transaction it shows.`,
      frames,
      continueLabel: 'Scan the signed transaction',
    });

    const signatures = await this.opts.bridge.scan({
      purpose: 'signed-psbt',
      title: 'Scan the signed transaction',
      instructions: `Show the signed transaction on your ${this.opts.label} as a QR code and point this camera at it.`,
      // Conversion happens inside `accept`: a QR for another transaction becomes a hint and scanning goes on.
      accept: acceptFrames((payload) => {
        const signed = signedFromPayload(payload);
        return signed.kind === 'psbt' ? signaturesFromSignedPsbt(original, signed.bytes) : signaturesFromRawTransaction(original, signed.bytes);
      }),
    });
    if (signatures.length === 0) throw new HardwareError('invalid-response', `The ${this.opts.label} did not add any signature.`, { kind: this.kind });
    const { psbt } = mergePartialSignatures(original, signatures);
    assertDeviceSignedAll(psbt, this.info.fingerprint);
    return encodePsbtBase64(psbt);
  }

  /** The compressed pubkey at `path`, derived from the account key the device exported (scanned now if it is not known yet). */
  private async pubkeyAt(path: number[]): Promise<Uint8Array> {
    let hardened = 0;
    while (hardened < path.length && path[hardened]! >= HARDENED) hardened++;
    if (hardened === 0 || hardened === path.length) throw new HardwareError('invalid-request', `Trikey can only check a message key below an account key, not ${formatPath(path)}.`, { kind: this.kind });
    const xpub = await this.getXpub(formatPath(path.slice(0, hardened)));
    const network = getNetwork(this.opts.network);
    const key = HDKey.fromExtendedKey(xpub, network.bip32).derive(`m/${path.slice(hardened).join('/')}`);
    return key.publicKey!;
  }

  /**
   * BIP 137 with the key at `path`, the way the model signs a text (qr-devices.ts, `qrMessageMethod`): over a text QR
   * (message.ts: shows `signmessage <path> ascii:<text>`, scans the base64 signature or Coldcard's armored block), or
   * from a microSD card (sd-message.ts: hands over the request file, reads the signed file the device wrote, or its
   * QR). Either way the answer is checked against the key at `path`, derived from the account key the device exported,
   * before it is returned. A model that cannot sign a text is refused with its reason before anything is shown.
   */
  async signMessage(path: string, message: string, context: SignMessageContext = {}): Promise<string> {
    const info = qrModelInfo(this.opts.model);
    const method = qrMessageMethod(info.model);
    if (method === 'none')
      throw new HardwareNotSupportedError('signMessage', info.whyNot ?? `The ${info.name} can't sign a text by QR code.`, { kind: this.kind, devices: QR_DEVICES_WITHOUT_MESSAGE_SIGNING });
    const problem = messageProblemFor(info.model, message);
    if (problem) throw new HardwareError('invalid-request', problem, { kind: this.kind });
    const numbers = parsePath(path);
    const pubkey = await this.pubkeyAt(numbers);
    const shownPath = formatPath(numbers);
    const account = numbers[2] !== undefined && numbers[2] >= HARDENED ? numbers[2] - HARDENED : 0;
    const label = info.name;
    const { p2pkh } = messageAddresses(pubkey, this.opts.network);
    const round = context.round && context.round.of > 1 ? context.round : undefined;
    const check = { text: message, pubkey, network: this.opts.network, path, label, ...(info.signsFromAccount ? { account } : {}) };
    const notes = (how: 'qr' | 'file') => [
      ...(context.purpose ? [PURPOSE_NOTE[context.purpose]] : []),
      ...(round
        ? [
            round.n === 1
              ? how === 'file'
                ? `Your ${label} signs the same text ${round.of === 2 ? 'twice' : `${round.of} times`}, from ${round.of === 2 ? 'two files' : `${round.of} files`}: this is the first. Trikey checks that it signs the same way every time, so the same key can be made again later.`
                : `Your ${label} will show the same text ${round.of === 2 ? 'twice' : `${round.of} times`}. Sign it each time: Trikey checks that it signs the same way every time, so the same key can be made again later.`
              : how === 'file'
                ? `Round ${round.n} of ${round.of}: the same text again, in a new file. Sign it once more and bring back the new signed file.`
                : `Round ${round.n} of ${round.of}: the same text again. Sign it once more.`,
          ]
        : []),
      `Your ${label} shows the text before it signs: check that it is exactly the text above.`,
      ...(info.displayLength && message.length > info.displayLength
        ? [
            info.model === 'krux'
              ? `This text is ${message.length} characters. On a small screen the ${label} shows about the first ${info.displayLength} and then "…" (a larger screen shows more): check that part, and the address.`
              : `This text is ${message.length} characters. The ${label} shows about the first ${info.displayLength} and then "...": check that part, and the path.`,
          ]
        : []),
      ...(info.showsAddress === 'p2pkh' ? [`It shows this address for the key: ${p2pkh}`] : []),
    ];
    const title = round ? `Sign on your ${label} (${round.n} of ${round.of})` : `Sign on your ${label}`;

    if (method === 'microsd') return this.signMessageFromCard(info, path, message, { shownPath, account, round, title, notes: notes('file'), check, purpose: context.purpose });

    const request = signMessageRequest(path, message);
    const fill = (t: string) => t.replaceAll('{path}', shownPath).replaceAll('{account}', String(account));
    await this.opts.bridge.show({
      purpose: 'message',
      title,
      instructions: `Scan this code with your ${label}. It asks it to sign the short text below with the key ${shownPath}, the key that approves changes for this wallet.`,
      frames: [request],
      detail: message,
      steps: (info.messageSteps ?? []).map(fill),
      notes: notes('qr'),
      continueLabel: 'Scan the signature',
    });

    return this.opts.bridge.scan({
      purpose: 'signed-message',
      title: 'Scan the signature',
      instructions: `Show the signature on your ${label} as a QR code and point this camera at it.`,
      // A wrong key or another text becomes a hint: the owner can sign again on the device and scan the new one.
      accept: acceptFrames((payload) => checkMessageAnswer(parseMessageAnswer(payload), check)),
    });
  }

  /**
   * The microSD round trip (sd-message.ts): one file request on the bridge. The owner saves the request file to the
   * card (or shares it to a computer), signs on the device, and picks the signed file it wrote (or, on Krux, scans the
   * signature QR). A wrong file, key or text stays on the screen as a hint; only a signature that verifies returns.
   */
  private async signMessageFromCard(
    info: QrModelInfo,
    path: string,
    message: string,
    o: {
      shownPath: string;
      account: number;
      round?: { n: number; of: number };
      title: string;
      notes: string[];
      check: Parameters<typeof checkMessageAnswer>[1];
      purpose?: SignMessageContext['purpose'];
    },
  ): Promise<string> {
    const format = sdFormatOf(info.model);
    if (!format) throw new HardwareNotSupportedError('signMessage', `Trikey doesn't know the ${info.name}'s microSD file format.`, { kind: this.kind, devices: QR_DEVICES_WITHOUT_MESSAGE_SIGNING });
    const file = sdRequestFile(format, path, message, { ...(o.purpose ? { purpose: o.purpose } : {}), ...(o.round ? { round: o.round } : {}) });
    const label = info.name;
    const fill = (t: string) =>
      t.replaceAll('{path}', o.shownPath).replaceAll('{account}', String(o.account)).replaceAll('{file}', file.name).replaceAll('{base}', baseName(file.name));
    return this.opts.bridge.file({
      purpose: 'message-file',
      title: o.title,
      instructions: `Your ${label} signs this text from a file on its microSD card. Save ${file.name} to the card, sign it on the ${label}, then open the signed file it writes. It signs with the key ${o.shownPath}, the key that approves changes for this wallet.`,
      file,
      detail: message,
      steps: [
        `Save ${file.name} to the microSD card: tap “Save the file” and pick the card (in a card reader on this phone), or share it to a computer and copy it onto the card.`,
        ...(info.messageSteps ?? []).map(fill),
      ],
      notes: o.notes,
      acceptFile: (picked) => {
        try {
          return { done: true, value: checkMessageAnswer(parseSignedFile(picked, file, label, o.round), { ...o.check, via: 'file' }) };
        } catch (e) {
          return { done: false, hint: e instanceof Error ? e.message : String(e) };
        }
      },
      ...(info.answersByQr ? { acceptFrame: acceptFrames((payload) => checkMessageAnswer(parseMessageAnswer(payload), o.check)) } : {}),
    });
  }

  async close(): Promise<void> {
    // Nothing is connected. If a QR sheet is still up, the host closes it.
  }
}

