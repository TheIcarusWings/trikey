/**
 * Receive's "Label this address" (coin control, DESIGN.md "Coin control"): a label on the address about to be shared
 * ("Invoice 42", "From Maria"), kept on this phone and in its backup as a BIP 329 `addr` record, never sent to the
 * guardian. A coin received there later shows it in the coin list when it has no label of its own, and its payment in
 * Activity. Renders nothing where coin control is not there (Recovery Key mode).
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Tag } from '@/components/icons';
import { FieldLabel, Footnote } from '@/components/panels';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useWallet, useWalletService, type CoinWallet } from '@/data';
import { useAction } from '@/lib/use-action';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

export function AddressLabelField({ wallet, address }: { wallet: CoinWallet; address: string }) {
  const service = useWalletService();
  const { labelsVersion } = useWallet();
  const coins = service.coins;
  const saved = useMemo(
    () => (address && coins ? coins.addressLabel(wallet, address) : undefined),
    // Read again when a label changes anywhere (an import, this field).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [coins, wallet, address, labelsVersion],
  );
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(saved ?? '');
  const save = useAction();
  useEffect(() => {
    setText(saved ?? '');
  }, [saved, address]);

  if (!coins || !address) return null;

  if (!editing) {
    return (
      <Pressable
        role="button"
        onPress={() => setEditing(true)}
        accessibilityLabel={saved ? `Label: ${saved}. Change the label` : 'Label this address'}
        className="min-h-11 flex-row items-center justify-center gap-2 self-center px-3 active:opacity-60">
        <Icon as={Tag} size={16} className="text-muted-foreground" />
        <Text className={cn('text-muted-foreground font-medium', pick('text-[15px]', 'text-sm'))}>
          {saved ? <Text className="text-foreground font-medium">{saved}</Text> : 'Label this address'}
          {saved ? ' · Change' : ''}
        </Text>
      </Pressable>
    );
  }

  const changed = text.trim() !== (saved ?? '');
  const done = async () => {
    if (!changed) return setEditing(false);
    const r = await save.run(coins.setAddressLabel(wallet, address, text));
    if (r.ok) setEditing(false);
  };
  return (
    <View className="gap-1.5">
      <FieldLabel nativeID="address-label">Label this address</FieldLabel>
      <Input aria-labelledby="address-label" value={text} onChangeText={setText} placeholder="Who pays, or what it's for" maxLength={255} returnKeyType="done" autoFocus onSubmitEditing={() => void done()} />
      <Footnote>Only on this phone and in its backup. Coins received at this address show it.</Footnote>
      <ActionNotice message={save.message} error={save.error} />
      <AppButton title={!changed ? 'Done' : text.trim() ? 'Save label' : 'Remove label'} variant="secondary" busy={save.busy} onPress={() => void done()} />
    </View>
  );
}
