import { View } from 'react-native';
import { TriangleAlert } from '@/components/icons';
import { Notice } from '@/components/panels';
import { Segmented } from '@/components/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { GUARDIAN_NETWORKS, useWallet, useWalletService, type NetworkName } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

const LABEL: Record<NetworkName, string> = { bitcoin: 'Mainnet', testnet: 'Testnet', signet: 'Signet', regtest: 'Regtest' };

/**
 * Which bitcoin network the new wallet lives on. Testnet is the default. Mainnet is offered while the project is
 * pre-alpha, for the guardian mode only (picking it moves a phone that was heading for Recovery Key mode back to the
 * guardian mode): the warning under the picker has to be accepted before onboarding goes on.
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
        options={GUARDIAN_NETWORKS.map((n) => ({ value: n, label: LABEL[n] }))}
        value={network ?? 'testnet'}
        onChange={(n) => wallet.setNetwork(n)}
      />
      {network === 'bitcoin' ? <MainnetWarning /> : null}
    </View>
  );
}

/** True while the phone is on mainnet and the person has not accepted the warning: onboarding waits. */
export function mainnetBlocked(state: { network: NetworkName | null; mainnetRiskAccepted: boolean }): boolean {
  return state.network === 'bitcoin' && !state.mainnetRiskAccepted;
}

/**
 * Real bitcoin on a pre-alpha wallet: what that means, and the switch that says the person read it. The answer is kept
 * by the wallet service (it outlives this screen), and goes away when the network changes.
 */
export function MainnetWarning() {
  const wallet = useWalletService();
  const { mainnetRiskAccepted } = useWallet();
  return (
    <View className="gap-1">
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn" title="Mainnet means real bitcoin">
        Trikey is pre-alpha and has not been audited. A bug could lose what you put in. Use only an amount you can afford to lose.
      </Notice>
      <View className="min-h-11 flex-row items-center justify-between gap-4">
        <Text nativeID="mainnet-ack-label" className={cn('flex-1', pick('text-[15px] leading-5', 'text-sm leading-5'))}>
          I understand, and I'll use a small amount
        </Text>
        <Switch
          checked={mainnetRiskAccepted}
          onCheckedChange={(on) => wallet.acceptMainnetRisk(on)}
          aria-labelledby="mainnet-ack-label"
          accessibilityLabel="I understand, and I'll use a small amount"
        />
      </View>
    </View>
  );
}
