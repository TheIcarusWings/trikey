import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { TriangleAlert } from '@/components/icons';
import { Body, FieldLabel, Footnote, InfoRow, ListGroup, Notice, Panel, SettingsRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { formatSats, includeFrozenNote, includeFrozenText, removeBlocker, useWallet, useWalletService, walletNameProblem } from '@/data';
import { useAction } from '@/lib/use-action';

/**
 * Settings > Wallets > a wallet (docs/design/multi-wallet.md, "Removing a wallet"): rename it on this phone, and remove
 * a wallet added after the first. Removing needs the wallet empty (its Savings too): its money moves to another wallet
 * of this phone first, an explicit payment like any other. Then the guardian retires it, with its hardware wallet's
 * approval, and says so; its account is never used again. The first wallet goes last ("Remove this wallet").
 *
 * Frozen coins (coin control) stay where they are on "Move everything", as with any Send max, so the move offers to
 * include them by name ("Include 1 frozen coin (3,000 sats)"), off by default: a coin is frozen to be kept apart, and
 * spending it with the others links them on chain. Included, the move empties the wallet in one payment.
 */
export default function WalletDetail() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { account } = useLocalSearchParams<{ account?: string }>();
  const view = state.wallets;
  const item = view?.list.find((w) => String(w.account) === account);
  const [name, setName] = useState(item?.name ?? '');
  const [to, setTo] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [includeFrozen, setIncludeFrozen] = useState(false);
  const rename = useAction();
  const move = useAction();
  const remove = useAction();

  if (!view || !item)
    return (
      <Screen title="Wallet" backLabel="Wallets">
        <Body>This wallet is no longer on this phone.</Body>
      </Screen>
    );

  const others = view.list.filter((w) => w.account !== item.account);
  const target = others.find((w) => w.account === to) ?? others[0];
  const renamed = name.trim() !== item.name;
  const problem = renamed ? walletNameProblem(name, { ...view, list: others }) : undefined;
  const blocker = removeBlocker(item);
  const frozen = item.frozen;
  const onlyFrozen = !!frozen && frozen.sats >= item.balanceSats;

  return (
    <Screen title={item.name} backLabel="Wallets">
      <Panel>
        <InfoRow plainLabel label="Hardware wallet" value={item.device} />
        <InfoRow plainLabel label="Balance" value={`${formatSats(item.balanceSats)} sats`} tabular />
        {item.savingsSats !== undefined ? <InfoRow plainLabel label="Savings" value={`${formatSats(item.savingsSats)} sats`} tabular /> : null}
        <InfoRow plainLabel label="Daily limit" value={item.limitOff ? 'None' : `${formatSats(item.dailyLimitSats)} sats`} tabular />
      </Panel>

      <View className="gap-1.5">
        <FieldLabel nativeID="rename-label">Name</FieldLabel>
        <Input aria-labelledby="rename-label" value={name} onChangeText={setName} maxLength={16} autoCapitalize="words" />
        {problem ? <Footnote className="text-destructive">{problem}</Footnote> : <Footnote>The name on this phone. The guardian and the hardware wallet keep the one they were given.</Footnote>}
        <ActionNotice message={rename.message} error={rename.error} />
        {renamed ? (
          <AppButton title="Save the name" variant="secondary" busy={rename.busy} disabled={!!problem} onPress={() => void rename.run(wallet.renameWallet!(item.account, name.trim()))} />
        ) : null}
      </View>

      {item.account === 0 ? (
        <Footnote>
          {others.length
            ? 'This is your first wallet: it holds the pairing with your guardian, so it is removed last, after the others.'
            : 'To remove your only wallet, use "Remove this wallet" in Settings.'}
        </Footnote>
      ) : (
        <View className="gap-3">
          <FieldLabel>Remove this wallet</FieldLabel>
          {blocker === 'money' ? (
            <>
              <Body>
                {onlyFrozen
                  ? `"${item.name}" holds only frozen coins now: ${formatSats(frozen!.sats)} sats. Include them below to move them too, or unfreeze them in Coins.`
                  : `"${item.name}" still holds ${formatSats(item.balanceSats)} sats${frozen ? `, ${formatSats(frozen.sats)} of them in frozen coins` : ''}. Move them to another wallet first: a payment like any other, approved on the ${item.device} when it is over the daily limit.`}
              </Body>
              <ListGroup>
                {others.map((o) => (
                  <SettingsRow key={o.account} title={o.name} subtitle={o.device} value={o.account === target?.account ? 'Moves here' : undefined} onPress={() => setTo(o.account)} />
                ))}
              </ListGroup>
              {frozen ? (
                <Panel>
                  <View className="flex-row items-center justify-between gap-4 px-4 py-3">
                    <View className="flex-1 gap-0.5">
                      <Text nativeID="include-frozen" className="text-[15px] leading-5">
                        {includeFrozenText(frozen)}
                      </Text>
                      <Text className="text-muted-foreground text-[13px] leading-[18px]">{includeFrozenNote(frozen, includeFrozen)}</Text>
                    </View>
                    <Switch
                      checked={includeFrozen}
                      disabled={move.busy}
                      onCheckedChange={setIncludeFrozen}
                      aria-labelledby="include-frozen"
                      accessibilityLabel={`${includeFrozenText(frozen)}: ${includeFrozen ? 'on' : 'off'}`}
                    />
                  </View>
                </Panel>
              ) : null}
              <ActionNotice message={move.message} error={move.error} />
              {target ? (
                <AppButton
                  title={onlyFrozen && !includeFrozen ? 'Include the frozen coins to move them' : `Move everything to "${target.name}"`}
                  busy={move.busy}
                  disabled={onlyFrozen && !includeFrozen}
                  onPress={async () => {
                    const r = await move.run(wallet.moveWalletFunds!(item.account, target.account, frozen && includeFrozen ? { includeFrozen: true } : {}));
                    if (r.ok) setIncludeFrozen(false);
                  }}
                />
              ) : null}
            </>
          ) : blocker === 'savings' ? (
            <Body>{`Its Savings still hold ${formatSats(item.savingsSats ?? 0)} sats. Move them out from the Savings screen of "${item.name}" first.`}</Body>
          ) : confirming ? (
            <>
              <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title={`Remove "${item.name}"?`}>
                {`The guardian retires it (approve on the ${item.device}) and co-signs nothing for it any more. Coins sent to its addresses later still need its hardware wallet to move. Make a new backup afterwards.`}
              </Notice>
              <ActionNotice message={remove.message} error={remove.error} />
              <AppButton
                title="Remove the wallet"
                variant="destructive"
                busy={remove.busy}
                onPress={async () => {
                  const r = await remove.run(wallet.removeWallet!(item.account));
                  if (r.ok) router.back();
                }}
              />
              <AppButton title="Keep it" variant="ghost" onPress={() => setConfirming(false)} />
            </>
          ) : (
            <AppButton title="Remove this wallet" variant="secondary" onPress={() => setConfirming(true)} />
          )}
        </View>
      )}
    </Screen>
  );
}
