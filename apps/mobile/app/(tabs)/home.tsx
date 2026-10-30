import {
  ActivityPreview,
  BalanceHeader,
  GuardianDownNotice,
  HardwareConfirmCard,
  LimitCard,
  RecoveryBanner,
  SendReceiveButtons,
  SilentPaymentsRow,
} from '@/components/home';
import { RecoveryKeyNotices, VaultCard } from '@/components/home-rk';
import { Footnote, NetworkPill } from '@/components/panels';
import { Screen } from '@/components/screen';
import { useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';

/**
 * Home has three faces, all behind the same tab:
 *  - Recovery Key mode: spending balance, vault and refills (RK-Home)
 *  - guardian mode, guardian locked or offline: unlock prompt (Home-Locked)
 *  - guardian mode, guardian online: balance, daily limit, recent activity (Home)
 */
export default function HomeScreen() {
  const state = useWallet();
  const wallet = useWalletService();
  const refresh = () => wallet.sync();

  if (state.mode === 'recoveryKey') {
    return (
      <Screen tab untitled title="Trikey" titleAccessory={<NetworkPill />} androidTitleWeight="normal" gap={20} onRefresh={refresh}>
        <RecoveryKeyNotices />
        <BalanceHeader
          label="Spending balance"
          sats={state.recoveryKey.spendingSats}
          caption={
            state.backing !== 'demo' && !state.synced
              ? state.syncing
                ? 'Reading the chain…'
                : 'Not synced yet. Pull down to refresh.'
              : pick(`Spend with Face ID, no ${state.hardware.brand} needed`, `Spend with your fingerprint, no ${state.hardware.brand} needed`)
          }
        />
        <SendReceiveButtons />
        <VaultCard />
        <ActivityPreview limit={2} />
      </Screen>
    );
  }

  const down = state.guardian.status !== 'online';
  if (down) {
    return (
      <Screen tab untitled title="Trikey" titleAccessory={<NetworkPill />} androidTitleWeight="normal" gap={20} onRefresh={refresh}>
        <RecoveryBanner />
        <HardwareConfirmCard />
        <BalanceHeader label="Balance" sats={state.balanceSats} />
        <GuardianDownNotice />
        <SendReceiveButtons sendEmphasis={false} />
        <SilentPaymentsRow />
        <Footnote className={pick('', 'text-xs leading-4')}>
          You can still send any amount by approving on your hardware wallet.
        </Footnote>
      </Screen>
    );
  }

  return (
    <Screen tab untitled title="Trikey" titleAccessory={<NetworkPill />} androidTitleWeight="normal" gap={20} onRefresh={refresh}>
      <RecoveryBanner />
      <HardwareConfirmCard />
      <BalanceHeader label="Balance" sats={state.balanceSats} />
      <SendReceiveButtons />
      <LimitCard />
      <SilentPaymentsRow />
      <ActivityPreview limit={3} />
    </Screen>
  );
}
