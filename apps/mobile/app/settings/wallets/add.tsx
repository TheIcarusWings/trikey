import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { HardwareList } from '@/components/hardware-list';
import { HardwareWallet, Smartphone } from '@/components/icons';
import { Body, FieldLabel, Footnote, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import {
  BACKUP_AFTER_ADD,
  GUARDIAN_UPDATE_NOTICE,
  SHARED_PHONE_NOTICE,
  formatSats,
  useWallet,
  useWalletService,
  walletNameProblem,
  hardwareBrandOf,
  type HardwareKind,
  type QrModel,
  type WalletListItem,
} from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

const DEFAULT_LIMIT = 100_000;

/**
 * "Add a wallet" (docs/design/multi-wallet.md): a name, its daily limit, then the NEW hardware wallet. The phone key is
 * the same; the guardian gives the wallet its own key at its own account, so nothing on chain links it to the others.
 * The device registers the wallet under its name and shows the first address. The first wallet's hardware wallet approves
 * adding it (guardians with `add_wallet_approval`). Then a new backup.
 */
export default function AddWallet() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const view = state.wallets;
  const [name, setName] = useState('');
  const [limit, setLimit] = useState(formatSats(DEFAULT_LIMIT));
  const [kind, setKind] = useState<HardwareKind | null>(null);
  const [qrModel, setQrModel] = useState<QrModel | undefined>(undefined);
  const [added, setAdded] = useState<WalletListItem | null>(null);
  const { busy, run, message, error } = useAction();
  const problem = name ? walletNameProblem(name, view) : undefined;
  const limitSats = Number(limit.replace(/\D/g, ''));

  if (view && !view.canAdd && !added)
    return (
      <Screen title="Add a wallet" backLabel="Wallets">
        <Body>{view.guardianUpdateNeeded ? GUARDIAN_UPDATE_NOTICE : 'This phone holds as many wallets as it can (8).'}</Body>
      </Screen>
    );

  if (added)
    return (
      <Screen
        title="Wallet added"
        backLabel="Wallets"
        footer={
          <>
            <AppButton title="Back up now" onPress={() => router.replace({ pathname: '/backup', params: { again: '1' } })} />
            <AppButton title="Later" variant="secondary" onPress={() => router.back()} />
          </>
        }>
        <Body>{`"${added.name}" is on your guardian, with ${added.device}. Switch to it at the top of Home.`}</Body>
        <Notice icon={Smartphone} title="A shared phone is a shared key">
          {SHARED_PHONE_NOTICE}
        </Notice>
        <Notice icon={HardwareWallet} tone="warn">
          {BACKUP_AFTER_ADD}
        </Notice>
      </Screen>
    );

  const add = async () => {
    if (!kind) return;
    const r = await run(wallet.addWallet!({ name: name.trim(), hardware: kind, ...(qrModel ? { hardwareModel: qrModel } : {}), dailyLimitSats: limitSats }));
    if (r.ok) setAdded(r.value);
  };

  return (
    <Screen
      title="Add a wallet"
      backLabel="Wallets"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton
            title={busy ? 'Approve on your hardware wallets…' : 'Add the wallet'}
            busy={busy}
            disabled={!name || !!problem || !kind || !(limitSats > 0)}
            onPress={add}
          />
        </>
      }>
      <Body>
        A wallet with another hardware wallet: its own daily limit and recoveries. The other rules are your first wallet's; change them later in Settings. The
        new hardware wallet shows the rules for you to approve: check the daily limit (limit=, in sats) and the alert contacts on its screen. Then your first
        wallet's hardware wallet approves adding it (a text that starts with "Trikey add-wallet"), so nobody holding only this phone can add a wallet.
      </Body>
      <View className="gap-1.5">
        <FieldLabel nativeID="wallet-name">Name</FieldLabel>
        <Input aria-labelledby="wallet-name" value={name} onChangeText={setName} placeholder="Business" maxLength={16} autoCapitalize="words" />
        {problem ? <Footnote className="text-destructive">{problem}</Footnote> : <Footnote>Your hardware wallet shows it too.</Footnote>}
      </View>
      <View className="gap-1.5">
        <FieldLabel nativeID="wallet-limit">Daily limit</FieldLabel>
        <View className={cn('border-foreground flex-row items-center gap-2 rounded-[10px] border px-3', pick('h-12', 'h-[52px]'))}>
          <Input
            aria-labelledby="wallet-limit"
            keyboardType="number-pad"
            value={limit}
            onChangeText={(t) => {
              const digits = t.replace(/\D/g, '');
              setLimit(digits ? formatSats(Number(digits)) : '');
            }}
            className="h-full flex-1 border-0 bg-transparent px-0 text-lg font-medium tabular-nums focus-visible:ring-0"
          />
          <Text className="text-muted-foreground text-[15px]">sats</Text>
        </View>
      </View>
      <Notice icon={Smartphone}>{SHARED_PHONE_NOTICE}</Notice>
      <FieldLabel>The new hardware wallet</FieldLabel>
      {kind ? (
        <Body>{`Connect your new hardware wallet (${hardwareBrandOf(kind, qrModel)}). It must not be in another wallet on this phone.`}</Body>
      ) : (
        <HardwareList
          purpose="guardian"
          onPick={(k, m) => {
            setQrModel(m);
            setKind(k);
          }}
        />
      )}
    </Screen>
  );
}
