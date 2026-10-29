import type { LucideIcon } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { ChevronRight, Cloud, FileText, HardwareWallet, Smartphone } from '@/components/icons';
import { Body } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useWallet, useWalletService, type LostKey } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { useBusy } from '@/lib/use-busy';
import { cn } from '@/lib/utils';

function Option({
  icon,
  title,
  description,
  onPress,
  disabled,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable role="button" accessibilityLabel={`${title}. ${description}`} disabled={disabled} onPress={onPress} className={cn('active:opacity-70', disabled && 'opacity-60')}>
      <Card className={cn('flex-row items-start p-4', pick('gap-3.5', 'gap-4'))}>
        <Icon as={icon} size={22} className="text-foreground mt-px" strokeWidth={1.8} />
        <View className="flex-1 gap-1">
          <Text className={cn('font-semibold', pick('text-base leading-[22px]', 'text-base leading-6'))}>{title}</Text>
          <Text className="text-muted-foreground text-sm leading-5">{description}</Text>
        </View>
        {IS_IOS ? <Icon as={ChevronRight} size={18} className="text-chevron mt-0.5" strokeWidth={2} /> : null}
      </Card>
    </Pressable>
  );
}

/** "What happened?": which two keys can still be put together. */
export default function RecoverChoose() {
  const router = useRouter();
  const wallet = useWalletService();
  const { recoveryDelayDays } = useWallet();
  const [busy, run] = useBusy();

  const startRecovery = async (lostKey: LostKey) => {
    await run(wallet.startRecovery(lostKey));
    router.push('/recover/waiting');
  };

  return (
    <Screen title="What happened?" androidTitleBelow backLabel="Back">
      <Body>Any two of your three keys can get your money back. Pick what you still have.</Body>
      <Option
        icon={Cloud}
        title="New phone, backup still there"
        description="Restore from your cloud backup. Takes a minute."
        onPress={() => router.push('/recover/backup')}
      />
      <Option
        icon={Smartphone}
        title="Lost my phone and the backup"
        description={`Use your hardware wallet and guardian. Takes ${recoveryDelayDays} days, with alerts.`}
        disabled={busy}
        onPress={() => startRecovery('phone')}
      />
      <Option
        icon={HardwareWallet}
        title="Lost my hardware wallet"
        description={`Restore its seed words on a new device right away, or use this phone and the guardian (${recoveryDelayDays} days).`}
        disabled={busy}
        onPress={() => startRecovery('hardware')}
      />
      <Option
        icon={FileText}
        title="I have a Recovery Kit"
        description="No home server? Scan your kit and use the device you still have. No waiting."
        onPress={() => router.push('/recover/kit')}
      />
    </Screen>
  );
}
