import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check } from '@/components/icons';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * What a scanned invite carries. Family hosting is a later feature (DESIGN.md), so the
 * screen shows a fixed demo invite instead of reading one from the wallet.
 */
const INVITE = { host: 'Maria', box: "Maria's Umbrel", npub: 'npub1m4r1a…k2x9' };

const CANNOT = [
  'Spend your money. Her key is one of three.',
  'Lock you out. Phone and Ledger can always move it.',
  'Raise your daily limit. Only your Ledger can.',
  'See your balance or your addresses.',
];

const TRUSTING = [
  'Keeping her box online so phone-only payments work.',
  'Letting the recovery wait and alerts run honestly.',
  'Never helping someone who has your phone or Ledger.',
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text role="heading" className="text-sm font-semibold leading-5">
        {title}
      </Text>
      <View className={pick('gap-1.5', 'gap-2')}>{children}</View>
    </View>
  );
}

export default function GuardianInvite() {
  const router = useRouter();
  return (
    <Screen
      title={`${INVITE.host} invites you to use her guardian`}
      androidTitle="Guardian invite"
      iosTitleClass="text-[28px] leading-[34px] tracking-[-0.56px]"
      footer={
        <>
          <AppButton title="Accept and continue" onPress={() => router.push('/set-limit')} />
          <AppButton title="Decline" variant="outline" onPress={() => router.back()} />
        </>
      }>
      <Text className={cn('text-base leading-6', pick('hidden', ''))}>{INVITE.host} invites you to use her guardian.</Text>
      <Card className="flex-row items-center gap-3 px-4 py-3">
        <View className="bg-secondary size-10 shrink-0 items-center justify-center rounded-full">
          <Text className="text-base font-semibold">{INVITE.host[0]}</Text>
        </View>
        <View className="min-w-0 flex-1">
          <Text className={cn('font-medium', pick('text-base leading-[22px]', 'text-base leading-6'))}>{INVITE.box}</Text>
          <Text className="text-muted-foreground font-mono text-[13px] leading-[18px]">{INVITE.npub}</Text>
        </View>
      </Card>
      <Section title={`What ${INVITE.host} can't do`}>
        {CANNOT.map((line) => (
          <View key={line} className={cn('flex-row', pick('gap-2.5', 'gap-3'))}>
            <Icon as={Check} size={18} className="text-good mt-px" strokeWidth={2.2} />
            <Text className="flex-1 text-sm leading-5">{line}</Text>
          </View>
        ))}
      </Section>
      <Section title="What you're trusting her with">
        {TRUSTING.map((line) => (
          <View key={line} className={cn('flex-row', pick('gap-2.5', 'gap-3'))}>
            <Text className="text-muted-foreground w-[18px] text-center text-sm leading-5">{'·'}</Text>
            <Text className="flex-1 text-sm leading-5">{line}</Text>
          </View>
        ))}
      </Section>
      <Text className="text-muted-foreground text-[13px] leading-[18px]">You can switch to your own guardian any time.</Text>
    </Screen>
  );
}
