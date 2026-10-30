import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { QuestionHeading } from '@/components/choice';
import { Check } from '@/components/icons';
import { Body, QuietLink } from '@/components/panels';
import { Card } from '@/components/ui/card';
import { Screen } from '@/components/screen';
import { Segmented } from '@/components/segmented';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { DELAY_OPTIONS, WalletServiceError, formatSats, useWallet, useWalletService, type RecoveryDelayDays } from '@/data';
import { guardianBox } from '@/lib/labels';
import { IS_IOS, pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

type Preset = '100000' | '200000' | '500000' | 'custom';

const PRESETS: { value: Preset; label: string }[] = [
  { value: '100000', label: '100k' },
  { value: '200000', label: '200k' },
  { value: '500000', label: '500k' },
  { value: 'custom', label: 'Custom' },
];

export default function SetLimit() {
  const router = useRouter();
  const wallet = useWalletService();
  const { guardian, hardware, progress } = useWallet();
  const [preset, setPreset] = useState<Preset>('200000');
  const [custom, setCustom] = useState('');
  const [days, setDays] = useState<RecoveryDelayDays>(7);
  // The recommended rules are shown as they are; "Change" opens the two choices.
  const [changing, setChanging] = useState(false);
  const { busy, run, message, error } = useAction();

  const limit = preset === 'custom' ? Number(custom.replace(/\D/g, '')) : Number(preset);
  const valid = limit > 0;

  const approve = async () => {
    const r = await run(wallet.setUpRules(limit, days));
    if (r.ok) router.push('/backup');
  };

  // The guardian's pairing code lives for 5 minutes: when it ran out, the way forward is to scan a new one.
  const rescan = error instanceof WalletServiceError && (error.kind === 'pairing_expired' || error.kind === 'pairing_invalid');

  return (
    <Screen
      title="Your protection"
      step={{ n: 4, total: 5 }}
      backLabel="Back"
      beforeTitle={
        <View
          className={cn(
            'bg-good-soft flex-row items-center self-start',
            IS_IOS ? 'gap-1.5 rounded-full px-2.5 py-1' : 'h-8 gap-1.5 rounded-lg px-3'
          )}>
          <Icon as={Check} size={IS_IOS ? 16 : 18} className="text-good" strokeWidth={2.4} />
          <Text className={cn('text-good', pick('text-[13px] font-semibold leading-[18px]', 'text-sm font-medium leading-5'))}>
            Guardian found {'·'} {guardianBox(guardian)}
          </Text>
        </View>
      }
      footer={
        <>
          <ActionNotice message={message} error={error} />
          {rescan ? (
            <AppButton title="Scan the guardian again" size="hero" onPress={() => router.dismissTo('/scan-guardian')} />
          ) : (
            <AppButton
              title={busy ? (progress ?? `Waiting for your ${hardware.brand}…`) : `Approve on ${hardware.brand}`}
              size="hero"
              busy={busy}
              disabled={!valid}
              onPress={approve}
            />
          )}
        </>
      }>
      <Body>
        Bigger payments, and any change to these rules, need your {hardware.brand}. If a device is lost, recovery waits and alerts you and your
        contacts every day.
      </Body>
      <Card className={cn('gap-3.5 p-4', !changing && 'border-foreground')}>
        <View className="flex-row items-center justify-between">
          <Text className="text-[17px] font-semibold leading-[22px]">{changing ? 'Your choice' : 'Recommended'}</Text>
          {changing ? null : <Icon as={Check} size={20} strokeWidth={2.4} className="text-good" />}
        </View>
        <View className="gap-2.5">
          <View className="flex-row justify-between gap-3" accessible accessibilityLabel={`Phone-only payments up to ${formatSats(limit)} sats a day`}>
            <Text className="text-muted-foreground text-[15px] leading-5">Daily limit, phone only</Text>
            <Text className="text-[15px] font-medium leading-5 tabular-nums">{formatSats(limit)} sats</Text>
          </View>
          <View className="flex-row justify-between gap-3" accessible accessibilityLabel={`Security waiting period ${days} days`}>
            <Text className="text-muted-foreground text-[15px] leading-5">Security waiting period</Text>
            <Text className="text-[15px] font-medium leading-5">{days} days</Text>
          </View>
        </View>
      </Card>
      {changing ? (
        <>
          <QuestionHeading title="Daily limit" />
          <Segmented accessibilityLabel="Daily limit" options={PRESETS} value={preset} onChange={setPreset} android="outlined" boldSelected />
          {preset === 'custom' ? (
            <Input
              accessibilityLabel="Custom daily limit in sats"
              keyboardType="number-pad"
              placeholder="Amount in sats"
              value={custom ? formatSats(Number(custom.replace(/\D/g, ''))) : ''}
              onChangeText={setCustom}
              className="tabular-nums"
            />
          ) : null}
          <QuestionHeading title="Security waiting period" />
          <Segmented
            accessibilityLabel="Security waiting period"
            options={DELAY_OPTIONS.map((d) => ({ value: d, label: `${d} days` }))}
            value={days}
            onChange={setDays}
            android="outlined"
            boldSelected
          />
        </>
      ) : (
        <QuietLink title="Change" onPress={() => setChanging(true)} />
      )}
    </Screen>
  );
}
