import type { LucideIcon } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { HardwareWallet, Server, Smartphone } from '@/components/icons';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

function KeyExplainer({ icon, title, children, tinted }: { icon: LucideIcon; title: string; children: string; tinted?: boolean }) {
  return (
    <View className={cn('flex-row items-start', pick('gap-3.5', 'gap-4'))}>
      <View
        className={cn(
          'shrink-0 items-center justify-center',
          IS_IOS ? 'size-11 rounded-xl' : 'size-10 rounded-full',
          IS_IOS && !tinted && 'bg-background border-border border',
          (tinted || !IS_IOS) && 'bg-secondary'
        )}>
        <Icon as={icon} size={24} className="text-foreground" strokeWidth={1.8} />
      </View>
      <View className={cn('flex-1', pick('gap-0.5', 'gap-1'))}>
        <Text className={cn(pick('text-[17px] font-semibold leading-[22px]', 'text-base font-medium leading-6'))}>{title}</Text>
        <Text className={cn('text-muted-foreground', pick('text-[15px] leading-[21px]', 'text-sm leading-5'))}>{children}</Text>
      </View>
    </View>
  );
}

export default function HowItWorks() {
  const router = useRouter();
  return (
    <Screen
      title="Three keys, all yours"
      gap={20}
      footer={
        <>
          <Text className={cn('text-muted-foreground text-center', pick('text-[13px] leading-[18px]', 'text-xs leading-4'))}>
            You'll need a hardware wallet and an Umbrel or Start9 with Trikey Guardian installed.{' '}
            <Text
              role="link"
              onPress={() => router.push('/rk/create')}
              className={cn('text-foreground font-medium underline underline-offset-[3px]', pick('text-[13px]', 'text-xs'))}>
              No home server?
            </Text>
          </Text>
          <AppButton title="Continue" size="hero" onPress={() => router.push('/connect-hardware')} />
        </>
      }>
      <View className={pick('gap-5', 'gap-6')}>
        <KeyExplainer icon={HardwareWallet} title="Your hardware wallet">
          Approves big payments and rule changes. Ledger, Trezor and most others work.
        </KeyExplainer>
        <KeyExplainer icon={Smartphone} title="This phone">
          {pick('Signs every payment, behind Face ID.', 'Signs every payment, behind your fingerprint or face unlock.')}
        </KeyExplainer>
        <KeyExplainer icon={Server} title="Trikey Guardian" tinted>
          Runs on your Umbrel or Start9. Co-signs everyday payments up to your daily limit.
        </KeyExplainer>
      </View>
      <Card className="px-4 py-3.5">
        <Text className={pick('text-[15px] leading-[21px]', 'text-sm leading-5')}>
          Any two of them can move your money. One on its own can't.
        </Text>
      </Card>
    </Screen>
  );
}
