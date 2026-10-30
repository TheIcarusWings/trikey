import type { LucideIcon } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { ChevronRight, Cloud, FileText, HardwareWallet, Smartphone } from '@/components/icons';
import { Body, Pill } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useWallet, useWalletService, type LostKey } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

function Option({
  icon,
  title,
  description,
  tag,
  onPress,
  disabled,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  /** What it costs in time: "Right away", "7-day security waiting period". */
  tag?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable role="button" accessibilityLabel={`${title}. ${description}${tag ? ` ${tag}.` : ''}`} disabled={disabled} onPress={onPress} className={cn('active:opacity-70', disabled && 'opacity-60')}>
      <Card className={cn('flex-row items-start p-4', pick('gap-3.5', 'gap-4'))}>
        <Icon as={icon} size={22} className="text-foreground mt-px" strokeWidth={1.8} />
        <View className="flex-1 gap-1">
          <Text className={cn('font-semibold', pick('text-base leading-[22px]', 'text-base leading-6'))}>{title}</Text>
          <Text className="text-muted-foreground text-sm leading-5">{description}</Text>
          {tag ? (
            <View className="mt-1 flex-row">
              <Pill strong>{tag}</Pill>
            </View>
          ) : null}
        </View>
        {IS_IOS ? <Icon as={ChevronRight} size={18} className="text-chevron mt-0.5" strokeWidth={2} /> : null}
      </Card>
    </Pressable>
  );
}

/**
 * "What happened?": which two keys can still be put together.
 * On a phone that is already set up only the lost hardware wallet makes sense; on a new phone the others do.
 */
export default function RecoverChoose() {
  const router = useRouter();
  const wallet = useWalletService();
  const { recoveryDelayDays, onboarded, backing, mode } = useWallet();
  const { busy, run, message, error } = useAction();
  const demo = backing === 'demo';

  // The demo starts the recovery straight away, as the designs do; the real wallet first needs the guardian's address and a device.
  const startRecovery = async (lostKey: LostKey) => {
    // First the three points (the wait, cancelling, the fee); that screen starts it.
    router.push({ pathname: '/recover/explain', params: { lost: lostKey } });
  };

  // A Recovery Key wallet on this phone: its recoveries are the kit's (no guardian, no waiting).
  if (mode === 'recoveryKey' && onboarded) {
    return (
      <Screen title="What did you lose?" androidTitleBelow backLabel="Back">
        <Body>Any two of your three keys can get your money back, right away. Pick what you lost.</Body>
        <Option icon={FileText} title="Lost my Recovery Kit" description="Or it may have been seen. This phone and your hardware wallet move everything to a new vault with a new kit." onPress={() => router.push('/rk/replace')} />
        <Option
          icon={HardwareWallet}
          title="Lost my hardware wallet"
          description="Use your Recovery Kit and this phone to move everything to a new vault with a new hardware wallet."
          onPress={() => router.push({ pathname: '/recover/kit', params: { with: 'phone' } })}
        />
        <Body>Lost or stolen phone? Open Trikey on the new phone, choose "I already have a Trikey wallet", then "I have a Recovery Kit". You need the kit and your hardware wallet.</Body>
      </Screen>
    );
  }

  return (
    <Screen title="What did you lose?" androidTitleBelow backLabel="Back">
      <Body>
        {onboarded
          ? 'Your phone is fine, but your hardware wallet is gone. This phone and the guardian can move your money to a new one.'
          : 'Any two of your three keys can get your money back. Pick what you still have.'}
      </Body>
      {onboarded ? null : (
        <>
          <Option
            icon={Cloud}
            title="My phone, but I have its backup"
            description="Restore it on this new phone."
            tag="Right away"
            onPress={() => router.push('/recover/backup')}
          />
          <Option
            icon={Smartphone}
            title="My phone and its backup"
            description="Your hardware wallet and your guardian move your money to a new wallet."
            tag={`${recoveryDelayDays}-day security waiting period`}
            disabled={busy}
            onPress={() => startRecovery('phone')}
          />
        </>
      )}
      {onboarded || demo ? (
        <Option
          icon={HardwareWallet}
          title="My hardware wallet"
          description="Restore its seed words on a new device, or let this phone and your guardian move your money."
          tag={`Right away, or ${recoveryDelayDays} days`}
          disabled={busy}
          onPress={() => startRecovery('hardware')}
        />
      ) : null}
      {onboarded ? null : (
        <Option
          icon={FileText}
          title="I have a Recovery Kit"
          description="No home server? Scan your kit and use the device you still have."
          tag="Right away"
          onPress={() => router.push('/recover/kit')}
        />
      )}
      <ActionNotice message={message} error={error} />
    </Screen>
  );
}
