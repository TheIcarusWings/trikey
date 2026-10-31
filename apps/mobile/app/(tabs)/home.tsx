import {
  ActivityPreview,
  BalanceHeader,
  GuardianDownNotice,
  HardwareConfirmCard,
  HomeTopActions,
  LimitLine,
  RecoveryBanner,
  SendReceiveButtons,
  SilentPaymentsRow,
  StatusLine,
  useNewWallet,
} from '@/components/home';
import { RecoveryKeyNotices, VaultCard } from '@/components/home-rk';
import { Screen } from '@/components/screen';
import { useWallet, useWalletService } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';

/**
 * Home has three faces, all behind the same tab, and one layout: the network and Settings at the top, the balance
 * centred with one line under it, Send and Receive, then what needs attention and the latest payments.
 *  - Recovery Key mode: spending balance, vault and refills (RK-Home)
 *  - guardian mode, guardian locked or offline: phone-only payments paused (Home-Locked)
 *  - guardian mode, guardian online: what the phone can still pay today (Home); a new wallet leads with Receive
 */
export default function HomeScreen() {
  const state = useWallet();
  const wallet = useWalletService();
  const newWallet = useNewWallet();
  const refresh = () => wallet.sync();
  // Android shows the network and the gear in its top bar; iOS has no bar on Home, so they lead the content.
  const screen = { tab: true, untitled: true, title: 'Trikey', titleAccessory: IS_IOS ? undefined : <HomeTopActions />, androidTitleWeight: 'normal' as const, gap: 20, onRefresh: refresh };
  const top = IS_IOS ? <HomeTopActions /> : null;

  if (state.mode === 'recoveryKey') {
    const caption =
      state.backing !== 'demo' && !state.synced
        ? state.syncing
          ? 'Reading the chain…'
          : 'Not synced yet. Pull down to refresh.'
        : pick(`Spending balance · Face ID only, no ${state.hardware.brand}`, `Spending balance · fingerprint only, no ${state.hardware.brand}`);
    return (
      <Screen {...screen}>
        {top}
        <RecoveryKeyNotices />
        <BalanceHeader label="Spending balance" sats={state.recoveryKey.spendingSats} />
        <StatusLine tone="good" text={caption} />
        <SendReceiveButtons />
        <VaultCard />
        <ActivityPreview limit={2} />
      </Screen>
    );
  }

  const down = state.guardian.status !== 'online';
  const paused = down || !!state.recovery || state.phoneSpending === 'paused_contested';
  return (
    <Screen {...screen}>
      {top}
      <BalanceHeader label="Balance" sats={state.balanceSats} />
      {paused ? <StatusLine tone="warn" text={state.recovery ? 'Phone-only payments paused during recovery' : 'Phone-only payments paused'} /> : <LimitLine newWallet={newWallet} />}
      <SendReceiveButtons newWallet={newWallet} />
      <RecoveryBanner />
      <HardwareConfirmCard />
      {down ? <GuardianDownNotice /> : null}
      <SilentPaymentsRow />
      <ActivityPreview limit={3} newWallet={newWallet} />
    </Screen>
  );
}
