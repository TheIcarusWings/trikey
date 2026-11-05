import { useRouter } from 'expo-router';
import { AppButton } from '@/components/app-button';
import { Plus, Smartphone } from '@/components/icons';
import { Body, Footnote, ListGroup, Notice, SettingsRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { GUARDIAN_UPDATE_NOTICE, SHARED_PHONE_NOTICE, formatSats, hasSeveralWallets, totalLimitText, useWallet } from '@/data';

/**
 * Settings > Wallets (docs/design/multi-wallet.md): this phone's wallets on its guardian, each with its own hardware
 * wallet and rules, and "Add a wallet". They share the phone's key, its backup and the guardian.
 */
export default function WalletsSettings() {
  const router = useRouter();
  const state = useWallet();
  const view = state.wallets;
  const several = hasSeveralWallets(view);
  const total = several ? totalLimitText(view?.total) : null;

  return (
    <Screen
      title="Wallets"
      backLabel="Settings"
      footer={view?.canAdd ? <AppButton title="Add a wallet" icon={Plus} onPress={() => router.push('/settings/wallets/add')} /> : undefined}>
      <Body>Each wallet has its own hardware wallet, daily limit, alert contacts and recoveries. They share this phone's key, its backup and your guardian.</Body>
      {view ? (
        <ListGroup>
          {view.list.map((w) => (
            <SettingsRow
              key={w.account}
              title={w.name}
              subtitle={`${w.device} · ${w.limitOff ? 'no daily limit' : `${formatSats(w.dailyLimitSats)} sats a day`}`}
              value={w.current ? 'Shown' : `${formatSats(w.balanceSats)} sats`}
            />
          ))}
        </ListGroup>
      ) : null}
      {several ? (
        <Notice icon={Smartphone} title="A shared phone is a shared key">
          {`${SHARED_PHONE_NOTICE} ${total ?? ''}`.trim()}
        </Notice>
      ) : null}
      {view?.guardianUpdateNeeded ? <Footnote>{GUARDIAN_UPDATE_NOTICE}</Footnote> : null}
      <Footnote>Savings and silent payments stay with your first wallet for now.</Footnote>
    </Screen>
  );
}
