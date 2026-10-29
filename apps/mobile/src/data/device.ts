/**
 * The "Confirm on your device" plumbing, with no React in it so Node can test it:
 *
 * - `DevicePromptStore` holds what the hardware wallet is being asked right now; the sheet in
 *   `components/device-prompt-host.tsx` shows it and the wallet service copies it into `WalletState`.
 * - `withDevicePrompts` wraps a `HardwareProvider` so every call that makes the device wait for the person
 *   (public key, wallet registration, address, message, payment) opens the prompt for exactly as long as the call
 *   runs, and can be given up on.
 * - `compositeProvider` makes one provider out of Ledger, Trezor and QR.
 */
import { MultisigWallet, getNetwork, type NetworkName } from '@trikey/core';
import type { HardwareDeviceInfo, HardwareKind, HardwareProvider, HardwareSigner, HardwareWalletPolicy } from '@trikey/wallet';
import { WalletServiceError } from './errors';
import type { DevicePrompt } from './types';

export class DevicePromptStore {
  private current: DevicePrompt | null = null;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  private cancelActive?: () => void;
  /** The text of the last `hardware_prompt` event: what the device is about to show. */
  pendingDetail?: string;
  /**
   * Several signatures are asked for in a row (Recovery Key refills: one confirmation each). The wallet announces all of
   * them first; each `signPsbt` then takes the next one, and the sheet says "2 of 8".
   */
  private queue: { text: string; step?: number; steps?: number }[] = [];

  queueDetail(text: string, step?: number, steps?: number): void {
    this.queue.push({ text, step, steps });
  }

  /** The text (and place in a series) for the next signature: the next queued one, else the last single prompt's. */
  takeDetail(): { text?: string; step?: number; steps?: number } {
    const next = this.queue.shift();
    if (next) return next;
    const text = this.pendingDetail;
    this.pendingDetail = undefined;
    return { text };
  }

  /** Forgets what was announced and not asked (a signature failed or was given up on). */
  clearQueue(): void {
    this.queue = [];
    this.pendingDetail = undefined;
  }

  getSnapshot = (): DevicePrompt | null => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Opens (or replaces) the prompt. */
  show(title: string, opts: { detail?: string; hint?: string; cancel?: () => void } = {}): number {
    const id = this.nextId++;
    this.current = { id, title, detail: opts.detail, hint: opts.hint };
    this.cancelActive = opts.cancel;
    this.emit();
    return id;
  }

  /** Sets the device's current step on the open prompt. */
  setHint(hint: string | undefined): void {
    if (!this.current) return;
    this.current = { ...this.current, hint };
    this.emit();
  }

  /** Closes the prompt `id` (a later prompt that replaced it stays). */
  clear(id: number): void {
    if (this.current?.id !== id) return;
    this.current = null;
    this.cancelActive = undefined;
    this.emit();
  }

  clearAll(): void {
    if (!this.current) return;
    this.current = null;
    this.cancelActive = undefined;
    this.emit();
  }

  /** The person gave up: the call behind the prompt rejects with `cancelled`. */
  cancel(): void {
    const fn = this.cancelActive;
    this.cancelActive = undefined;
    fn?.();
    this.clearAll();
  }
}

const LEDGER_HINTS: Record<string, string> = {
  'unlock-device': 'Unlock your Ledger with its PIN.',
  'confirm-open-app': 'Open the Bitcoin app on your Ledger.',
  'allow-secure-connection': 'Allow the secure connection on your Ledger.',
  'allow-list-apps': 'Allow Trikey to list apps on your Ledger.',
  'sign-transaction': 'Review the payment on your Ledger and approve it.',
  'sign-personal-message': 'Review the message on your Ledger and approve it.',
  'verify-address': 'Compare the address on your Ledger and approve it.',
};

/** Words for a Ledger `requiredUserInteraction`; undefined when there is nothing to tell the person. */
export function ledgerHint(interaction: string): string | undefined {
  return LEDGER_HINTS[interaction];
}

const cancelled = () => new WalletServiceError('cancelled', 'Cancelled.');

/** Runs `op` while `title` is on screen; rejects with `cancelled` if the person gives up first. */
async function prompted<T>(store: DevicePromptStore, title: string, detail: string | undefined, op: () => Promise<T>): Promise<T> {
  let giveUp!: () => void;
  const gone = new Promise<never>((_, reject) => {
    giveUp = () => reject(cancelled());
  });
  const id = store.show(title, { detail, cancel: giveUp });
  try {
    return await Promise.race([op(), gone]);
  } finally {
    store.clear(id);
  }
}

export interface PromptOptions {
  network: NetworkName;
  /** Kinds whose own screens already tell the person what to do (QR devices show a full-screen scanner). */
  silentKinds?: readonly HardwareKind[];
}

function expectedAddress(policy: HardwareWalletPolicy, chain: 0 | 1, index: number, network: NetworkName): string | undefined {
  try {
    return MultisigWallet.fromDescriptor(policy.descriptor, getNetwork(network)).derive(chain, index).address;
  } catch {
    return undefined;
  }
}

class PromptingSigner implements HardwareSigner {
  constructor(
    private readonly inner: HardwareSigner,
    private readonly store: DevicePromptStore,
    private readonly opts: PromptOptions,
  ) {}

  get info(): HardwareDeviceInfo {
    return this.inner.info;
  }

  private silent(): boolean {
    return this.opts.silentKinds?.includes(this.inner.info.kind) ?? false;
  }

  private run<T>(title: string, detail: string | undefined, op: () => Promise<T>): Promise<T> {
    return this.silent() ? op() : prompted(this.store, title, detail, op);
  }

  getXpub(path: string) {
    return this.run('Confirm on your device', `Approve sharing the public key (${path}).`, () => this.inner.getXpub(path));
  }

  registerWallet(wallet: HardwareWalletPolicy) {
    return this.run('Confirm on your device', `Register the 2-of-3 wallet "${wallet.name}". Check that the device says Trikey, 2 of 3.`, () =>
      this.inner.registerWallet(wallet),
    );
  }

  displayAddress(wallet: HardwareWalletPolicy, chain: 0 | 1, index: number) {
    const expected = expectedAddress(wallet, chain, index, this.opts.network);
    return this.run(
      'Check the address on your device',
      expected ? `The device must show exactly this address:\n${expected}` : 'The device must show the same address as this phone.',
      () => this.inner.displayAddress(wallet, chain, index),
    );
  }

  signPsbt(psbtBase64: string, wallet: HardwareWalletPolicy) {
    const { text, step, steps } = this.store.takeDetail();
    const title = steps && steps > 1 && step ? `Confirm on your device (${step} of ${steps})` : 'Confirm on your device';
    return this.run(title, text ?? 'Review the payment on the device before approving.', () => this.inner.signPsbt(psbtBase64, wallet));
  }

  signMessage(path: string, message: string) {
    this.store.pendingDetail = undefined;
    return this.run('Confirm on your device', `Check that the device shows exactly this text:\n${message}`, () => this.inner.signMessage(path, message));
  }

  close() {
    return this.inner.close();
  }
}

/** The same provider, but every device call that waits for the person opens the "Confirm on your device" prompt. */
export function withDevicePrompts(inner: HardwareProvider, store: DevicePromptStore, opts: PromptOptions): HardwareProvider {
  return {
    kinds: inner.kinds,
    isAvailable: () => inner.isAvailable(),
    async connect(connectOpts) {
      const signer = await inner.connect(connectOpts);
      return new PromptingSigner(signer, store, opts);
    },
  };
}

/** One provider out of several: `connect({ kind })` goes to the one that handles that kind (the first, if no kind). */
export function compositeProvider(providers: HardwareProvider[]): HardwareProvider {
  const kinds = [...new Set(providers.flatMap((p) => [...p.kinds]))] as HardwareKind[];
  return {
    kinds,
    async isAvailable() {
      for (const p of providers) if (await p.isAvailable()) return true;
      return false;
    },
    async connect(opts = {}) {
      const target = opts.kind ? providers.find((p) => p.kinds.includes(opts.kind!)) : providers[0];
      if (!target) throw new WalletServiceError('hardware', "This phone can't connect that kind of hardware wallet.");
      return target.connect(opts);
    },
  };
}
