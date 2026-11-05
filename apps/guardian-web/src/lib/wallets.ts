/**
 * Own wallets (docs/design/multi-wallet.md): a guardian that guards several wallets of its owner shows one at a time on the
 * Wallet, Rules and Recovery pages, and names the wallet on every Activity entry. The choice is in the address
 * (`?wallet=<id>`), so a reload or a shared link shows the same wallet; without one, the first wallet, as before.
 */
import type { GuardianStatus, WalletSummary } from '../api/types';

/** The wallets to choose between: none while the guardian guards one wallet (no picker then). */
export function walletChoices(status: Pick<GuardianStatus, 'wallets'> | undefined): WalletSummary[] {
  const list = status?.wallets ?? [];
  return list.length > 1 ? list : [];
}

/**
 * The wallet a page shows: the one the address names, if the guardian guards it; else undefined, which means the first
 * wallet (the API's default: `/wallet`, `/rules`, `/recovery` without an id).
 */
export function selectedWalletId(status: Pick<GuardianStatus, 'wallets'> | undefined, requested: string | null): string | undefined {
  const choices = walletChoices(status);
  if (!requested || !choices.length) return undefined;
  const hit = choices.find((w) => w.id === requested);
  // The first wallet is the API's default: no id needed.
  return hit && hit !== choices[0] ? hit.id : undefined;
}

/** The selected wallet's name, for page titles ("Rules · Business"). */
export function selectedWalletName(status: Pick<GuardianStatus, 'wallets'> | undefined, requested: string | null): string | undefined {
  const choices = walletChoices(status);
  if (!choices.length) return undefined;
  return (choices.find((w) => w.id === requested) ?? choices[0])!.name;
}

/** The note on a shared phone: what someone who unlocks it can spend in a day, every wallet's limit added up. */
export function totalLimitText(status: Pick<GuardianStatus, 'wallets'> | undefined): string | null {
  const choices = walletChoices(status);
  if (!choices.length) return null;
  if (choices.some((w) => w.dailySpend?.limitOff)) return 'One of these wallets has no daily limit: the paired phone and this guardian together can send everything in it.';
  const total = choices.reduce((sum, w) => sum + (w.dailySpend?.limitSats ?? 0), 0);
  return `Together the daily limits add up to ${total.toLocaleString('en-US')} sats: what the paired phone and this guardian can send in a day without a hardware wallet.`;
}
