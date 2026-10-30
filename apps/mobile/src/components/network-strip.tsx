import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Info } from '@/components/icons';
import { networkLabel } from '@/components/panels';
import { Sheet } from '@/components/sheet';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useWallet } from '@/data';
import { pick } from '@/lib/platform';

/**
 * The thin strip across the top of every screen on a test network or in the demo, so test coins are never mistaken for
 * real ones: "Signet · pre-alpha · coins here have no value". A tap explains it. On mainnet there is no strip (the
 * pre-alpha warning on Welcome says what needs saying there).
 */
export function NetworkStrip() {
  const { backing, network } = useWallet();
  const [open, setOpen] = useState(false);
  const label = networkLabel(backing, network);
  if (!label) return null;
  const demo = backing === 'demo';
  const text = demo ? 'Demo · sample data, nothing here is real' : `${label} · pre-alpha · coins here have no value`;

  return (
    <>
      <Pressable
        role="button"
        accessibilityLabel={`${text}. Tap for more.`}
        onPress={() => setOpen(true)}
        className="bg-warn-soft min-h-11 flex-row items-center justify-center gap-1.5 px-4 py-2 active:opacity-80">
        <View className="bg-warn size-1.5 rounded-full" />
        <Text className="text-foreground text-xs font-semibold leading-4">{text}</Text>
        <Icon as={Info} size={14} strokeWidth={2.2} className="text-foreground" />
      </Pressable>
      <Sheet visible={open} title={demo ? "You're in the demo" : `You're on ${label}, a test network`} onClose={() => setOpen(false)}>
        <Text className={pick('text-muted-foreground text-[15px] leading-[22px]', 'text-muted-foreground text-sm leading-5')}>
          {demo
            ? 'Everything here is sample data. Nothing is sent and no bitcoin moves.'
            : "Coins here are test coins with no value, and Trikey is pre-alpha. Don't send real bitcoin to these addresses: it would be lost."}
        </Text>
        <Text className={pick('text-muted-foreground text-[15px] leading-[22px]', 'text-muted-foreground text-sm leading-5')}>
          The strip stays on every screen until the wallet is on the real network.
        </Text>
        <AppButton title="Close" onPress={() => setOpen(false)} />
      </Sheet>
    </>
  );
}
