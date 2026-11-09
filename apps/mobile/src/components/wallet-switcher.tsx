import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Check, ChevronRight, Plus } from '@/components/icons';
import { Footnote, ListGroup } from '@/components/panels';
import { Sheet } from '@/components/sheet';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats, hasSeveralWallets, showsWalletSwitcher, totalLimitText, useWallet, useWalletService, walletLine } from '@/data';
import { useAction } from '@/lib/use-action';
import { ActionNotice } from '@/components/action-notice';
import { cn } from '@/lib/utils';

/**
 * The top of Home with several wallets (docs/design/multi-wallet.md): the wallet shown and its hardware wallet ("Daily ·
 * Trezor Safe 3"); a tap opens the sheet of every wallet with its balance, and "Add a wallet". Hidden while Settings >
 * "Several wallets" is off (the default, with one wallet), and while the phone holds one wallet and its guardian cannot
 * hold more (`showsWalletSwitcher`).
 */
export function WalletSwitcher() {
  const state = useWallet();
  const wallet = useWalletService();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { run, message, error } = useAction();
  const view = state.wallets;
  if (!view || !showsWalletSwitcher(state)) return null;
  const several = hasSeveralWallets(view);
  const total = several ? totalLimitText(view.total) : null;

  const choose = async (account: number) => {
    if (account === view.current.account) return setOpen(false);
    const r = await run(wallet.switchWallet?.(account) ?? Promise.resolve());
    if (r.ok) setOpen(false);
  };

  return (
    <>
      <Pressable
        role="button"
        accessibilityLabel={`Wallet: ${walletLine(view.current)}. Change wallet`}
        onPress={() => setOpen(true)}
        className="active:bg-accent flex-row items-center gap-1.5 self-center rounded-full px-3 py-1.5">
        <Text className="text-[15px] font-semibold">{view.current.name}</Text>
        <Text className="text-muted-foreground text-[15px]">· {view.current.device}</Text>
        <Icon as={ChevronRight} size={16} className="text-muted-foreground rotate-90" />
      </Pressable>
      <Sheet visible={open} title="Wallets" onClose={() => setOpen(false)}>
        <ListGroup divided>
          {view.list.map((w) => (
            <Pressable
              key={w.account}
              role="radio"
              aria-checked={w.current}
              accessibilityLabel={`${walletLine(w)}, ${formatSats(w.balanceSats)} sats`}
              onPress={() => void choose(w.account)}
              className="active:bg-accent min-h-[56px] flex-row items-center gap-3 px-4 py-2.5">
              <View className="flex-1 gap-0.5">
                <Text className="text-base font-medium">{w.name}</Text>
                <Text className="text-muted-foreground text-[13px]">{w.device}</Text>
              </View>
              <Text className="text-muted-foreground text-[15px] tabular-nums">{formatSats(w.balanceSats)} sats</Text>
              <View className="w-5">{w.current ? <Icon as={Check} size={18} className="text-foreground" /> : null}</View>
            </Pressable>
          ))}
          {view.canAdd ? (
            <Pressable
              role="link"
              onPress={() => {
                setOpen(false);
                router.push('/settings/wallets/add');
              }}
              className="active:bg-accent min-h-[52px] flex-row items-center gap-3 px-4">
              <Icon as={Plus} size={18} className="text-foreground" />
              <Text className={cn('flex-1 text-base')}>Add a wallet</Text>
            </Pressable>
          ) : null}
        </ListGroup>
        {total ? <Footnote>{total}</Footnote> : null}
        <ActionNotice message={message} error={error} />
      </Sheet>
    </>
  );
}
