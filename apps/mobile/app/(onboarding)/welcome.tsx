import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Logo } from '@/components/icons';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

export default function Welcome() {
  const router = useRouter();
  return (
    <Screen
      bare
      scrollable={false}
      footer={
        <>
          <AppButton title="Create a wallet" size="hero" onPress={() => router.push('/how-it-works')} />
          <AppButton
            title="I already have a Trikey wallet"
            variant="ghost"
            size="hero"
            className={pick('', 'rounded-[10px]')}
            onPress={() => router.push('/recover/choose')}
          />
        </>
      }>
      <View className="flex-1 items-center justify-center gap-5">
        <Logo />
        <Text
          role="heading"
          aria-level={1}
          className={cn('text-center', pick('text-[34px] font-semibold leading-10 tracking-[-0.68px]', 'text-4xl font-normal leading-[44px]'))}>
          Trikey
        </Text>
        <Text className={cn('text-muted-foreground text-center', pick('max-w-[300px] text-[17px] leading-6', 'max-w-[320px] text-base leading-6'))}>
          A bitcoin wallet where all three keys are yours. No company holds one.
        </Text>
      </View>
    </Screen>
  );
}
