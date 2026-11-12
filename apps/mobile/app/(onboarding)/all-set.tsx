import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { CheckCircle, Rise } from '@/components/motion';
import { Footnote, ListGroup, SummaryRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { formatSats, useWallet, useWalletService } from '@/data';
import { cloudLabel, guardianBox } from '@/lib/labels';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { ALL_SET, staggerDelay } from '@/theme/motion';

/**
 * The end of setting up. Motion (docs/design/motion.md, section 4): the same circle and drawn check as Sent, then the
 * title and the six summary rows, 70ms apart. The buttons are there and usable from the first frame.
 */
export default function AllSet() {
  const router = useRouter();
  const wallet = useWalletService();
  const { hardware, backup, guardian, dailyLimit, recoveryDelayDays, contacts } = useWallet();

  const enter = (next: '/home' | '/receive') => {
    wallet.finishOnboarding();
    // Drop the onboarding screens from the back stack, then land on home.
    router.dismissAll();
    router.replace('/home');
    if (next === '/receive') router.push('/receive');
  };

  return (
    <Screen
      bare
      // The wallet is set up: back goes Home, as "Go to home" does, never into the setup screens.
      holdBack={() => enter('/home')}
      gap={20}
      footer={
        <>
          <AppButton title="Receive your first bitcoin" size="hero" onPress={() => enter('/receive')} />
          <AppButton title="Go to home" variant="ghost" size="hero" onPress={() => enter('/home')} />
        </>
      }>
      <View className="self-center">
        <CheckCircle at={0} checkAt={ALL_SET.checkAtMs} checkMs={ALL_SET.checkDrawMs} fromScale={ALL_SET.circleFromScale} fadeMs={ALL_SET.circleFadeMs} />
      </View>
      <Rise delay={ALL_SET.titleAtMs} distance={ALL_SET.rise}>
        <Text
          role="heading"
          aria-level={1}
          className={cn('text-center', pick('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', 'text-[28px] font-normal leading-9'))}>
          You're all set
        </Text>
      </Rise>
      <Rise delay={ALL_SET.listAtMs} distance={0} duration={ALL_SET.listFadeMs}>
        <ListGroup divided>
          {[
            <SummaryRow key="hw" label="Hardware wallet" value={hardware.model} />,
            <SummaryRow key="phone" label="This phone" value={backup ? `Backed up to ${cloudLabel(backup.provider)}` : 'Not backed up yet'} />,
            <SummaryRow key="guardian" label="Guardian" value={`${guardianBox(guardian)} · ${guardian.status}`} tone={guardian.status === 'online' ? 'good' : 'warn'} />,
            <SummaryRow key="contacts" label="Alert contacts" value={contacts.length === 0 ? 'None yet' : String(contacts.length)} tone={contacts.length === 0 ? 'warn' : 'muted'} />,
            <SummaryRow key="limit" label="Daily limit" value={`${formatSats(dailyLimit.limitSats)} sats`} tabular />,
            <SummaryRow key="delay" label="Security waiting period" value={`${recoveryDelayDays} days`} />,
          ].map((row, i) => (
            // Six rows, 70ms apart.
            <Rise key={row.key} delay={staggerDelay(i, ALL_SET.rowStepMs, ALL_SET.firstRowAtMs)} distance={ALL_SET.rise}>
              {row}
            </Rise>
          ))}
        </ListGroup>
      </Rise>
      {guardian.key3Note ? <Footnote className="text-center">{guardian.key3Note}</Footnote> : null}
    </Screen>
  );
}
