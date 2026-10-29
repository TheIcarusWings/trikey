import {
  ActivityPreview,
  BalanceHeader,
  GuardianDownNotice,
  LimitCard,
  RecoveryBanner,
  SendReceiveButtons,
  VaultCard,
} from '@/components/home';
import { Footnote } from '@/components/panels';
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
      <Screen tab untitled title="Trikey" androidTitleWeight="normal" gap={20} onRefresh={refresh}>
        <RecoveryBanner />
        <BalanceHeader
          label="Spending balance"
          sats={state.recoveryKey.spendingSats}
          caption={pick('Spend with Face ID, no Ledger needed', 'Spend with your fingerprint, no Ledger needed')}
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
      <Screen tab untitled title="Trikey" androidTitleWeight="normal" gap={20} onRefresh={refresh}>
        <RecoveryBanner />
        <BalanceHeader label="Balance" sats={state.balanceSats} />
        <GuardianDownNotice />
        <SendReceiveButtons sendEmphasis={false} />
        <Footnote className={pick('', 'text-xs leading-4')}>
          You can still send any amount by approving on your hardware wallet.
        </Footnote>
      </Screen>
    );
  }

  return (
    <Screen tab untitled title="Trikey" androidTitleWeight="normal" gap={20} onRefresh={refresh}>
      <RecoveryBanner />
      <BalanceHeader label="Balance" sats={state.balanceSats} />
      <SendReceiveButtons />
      <LimitCard />
      <ActivityPreview limit={3} />
    </Screen>
  );
}
