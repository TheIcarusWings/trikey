import { formatSats, remainingToday, type HardwareReason, type WalletState } from '@/data';

/** Why this payment needs the hardware wallet, in one or two sentences: on Review and on the device screen. */
export function explainHardware(reason: HardwareReason, amount: number, state: WalletState): string {
  const sats = `${formatSats(amount)} sats`;
  switch (reason) {
    case 'over-limit':
      return `${sats} is over today's limit of ${formatSats(remainingToday(state))} left. Your hardware wallet signs this one instead of the guardian.`;
    case 'over-spending-balance':
      return `${sats} is more than your spending balance of ${formatSats(state.recoveryKey.spendingSats)}. Your hardware wallet signs this one from the vault.`;
    case 'guardian-locked':
      return `The guardian is locked, so your hardware wallet signs this one instead of it. ${sats} goes out as soon as you approve.`;
    case 'guardian-offline':
      return `The guardian can't be reached, so your hardware wallet signs this one instead of it. ${sats} goes out as soon as you approve.`;
    case 'recovery-pending':
      return `Phone-only payments are paused while a recovery runs, so your hardware wallet signs this one. ${sats} goes out as soon as you approve.`;
    case 'phone-spending-paused':
      return `Phone-only payments are paused after a recovery was cancelled by someone else, so your hardware wallet signs this one. ${sats} goes out as soon as you approve.`;
    case 'requested':
      return state.mode === 'recoveryKey'
        ? `This payment comes from your vault, so your hardware wallet signs it with this phone. ${sats} goes out as soon as you approve.`
        : `You chose to approve this one on your hardware wallet. ${sats} goes out as soon as you approve.`;
  }
}
