import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Notice, Panel, InfoRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { HELPER_SUGGESTION, HelperExplainer, helperLine, useSilentPayments } from '@/components/silent-payments';
import { Info } from '@/components/icons';
import { Text } from '@/components/ui/text';
import { shorten } from '@/data';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * A payment to a silent payment address needs the helper coin, and there is none (or it is too small for its share of the
 * fee). One clear screen with one way forward: fund the helper, which the setup screen walks through. Receiving silent
 * payments does not need it, and neither does any other payment.
 */
export default function FundTheHelper() {
  const router = useRouter();
  const { address = '', why } = useLocalSearchParams<{ address?: string; amount?: string; why?: string }>();
  const { sp } = useSilentPayments();

  return (
    <Screen
      title="Fund the helper"
      backLabel="Back"
      footer={
        <>
          <AppButton title="Fund the helper" onPress={() => router.push('/silent/setup')} />
          <AppButton title="Back" variant="ghost" onPress={() => router.back()} />
        </>
      }>
      <Notice icon={Info} tone="fill" title={sp.helper.sats > 0 ? 'The helper coin is too small' : 'This payment needs a helper coin'}>
        {address ? `Silent payment to ${shorten(address, 12)}.` : 'A silent payment.'} {sp.helper.sats > 0 && why ? why : `Put in ${HELPER_SUGGESTION} first, then come back.`}
      </Notice>
      <HelperExplainer />
      <Panel>
        <InfoRow label="Helper coin" value={helperLine(sp)} tone={sp.helper.funded ? 'good' : 'muted'} tabular />
      </Panel>
      <View>
        <Text className={cn('text-muted-foreground', pick('text-[13px] leading-[18px]', 'text-xs leading-4'))}>Paying any other address works without it.</Text>
      </View>
    </Screen>
  );
}
