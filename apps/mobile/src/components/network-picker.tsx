import { View } from 'react-native';
import { Segmented } from '@/components/segmented';
import { Text } from '@/components/ui/text';
import { SELECTABLE_NETWORKS, useWallet, useWalletService, type NetworkName } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

const LABEL: Record<NetworkName, string> = { bitcoin: 'Mainnet', testnet: 'Testnet', signet: 'Signet', regtest: 'Regtest' };

/**
 * Which bitcoin network the new wallet lives on. Only test networks while the project is pre-alpha: Mainnet is shown,
 * disabled, so it is clear it is coming and not forgotten.
 */
export function NetworkPicker() {
  const wallet = useWalletService();
  const { network } = useWallet();
  return (
    <View className="gap-2 self-stretch">
      <Text className={cn('text-muted-foreground text-center', pick('text-[13px] leading-[18px]', 'text-xs leading-4'))}>
        Network
      </Text>
      <Segmented<NetworkName>
        accessibilityLabel="Network"
        options={SELECTABLE_NETWORKS.map((n) => ({ value: n, label: LABEL[n] }))}
        value={network ?? 'testnet'}
        onChange={(n) => wallet.setNetwork(n)}
      />
      <Text accessibilityState={{ disabled: true }} className="text-muted-foreground text-center text-[13px] leading-[18px] opacity-60">
        Mainnet (not yet)
      </Text>
    </View>
  );
}
