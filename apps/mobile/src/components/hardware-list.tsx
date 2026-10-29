import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronRight } from '@/components/icons';
import { Body, ListGroup } from '@/components/panels';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useWalletService, type HardwareKind, type HardwareOption } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * The hardware wallets this phone can talk to (Ledger, Trezor, QR devices; the simulated device in the simulator),
 * asked of the wallet. Used when connecting the first one and when connecting a replacement.
 */
export function HardwareList({ onPick }: { onPick: (kind: HardwareKind) => void }) {
  const wallet = useWalletService();
  const [options, setOptions] = useState<HardwareOption[] | null>(null);

  useEffect(() => {
    let off = false;
    void wallet.getHardwareOptions().then((o) => !off && setOptions(o));
    return () => {
      off = true;
    };
  }, [wallet]);

  if (!options) return <Body>Looking for what this phone can connect to…</Body>;
  if (options.length === 0)
    return (
      <Body>
        This device can't connect to a hardware wallet. Open the app on a phone, or switch to the Demo or the Simulator in Settings, Developer.
      </Body>
    );

  return (
    <ListGroup>
      {options.map((option) => (
        <Pressable
          key={option.kind}
          role="link"
          disabled={!option.available}
          accessibilityLabel={`${option.name}. ${option.detail}${option.available ? '' : '. Not available on this phone right now'}`}
          onPress={() => onPick(option.kind)}
          className={cn(
            'flex-row items-center gap-3 active:bg-accent',
            pick('min-h-[60px] px-4 py-3', 'min-h-[72px] gap-4 px-0 py-3'),
            !option.available && 'opacity-50'
          )}>
          <View className="flex-1">
            <Text className={pick('text-[17px] leading-[22px]', 'text-base leading-6')}>{option.name}</Text>
            <Text className={cn('text-muted-foreground', pick('text-[13px] leading-[18px]', 'text-sm leading-5'))}>
              {option.available ? option.detail : 'Not available on this phone right now'}
            </Text>
          </View>
          <Icon as={ChevronRight} size={pick(20, 24)} className={IS_IOS ? 'text-chevron' : 'text-muted-foreground'} strokeWidth={2} />
        </Pressable>
      ))}
    </ListGroup>
  );
}
