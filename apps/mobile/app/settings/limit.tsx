import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { HardwareWallet, Smartphone, TriangleAlert } from '@/components/icons';
import { Body, FieldLabel, Footnote, Notice, QuietLink } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { canOfferLimitOff, formatSats, limitChangeNeedsHardware, limitIsOff, limitToRestore, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

/** The amount field, in sats. */
function LimitField({ label, value, onChange }: { label: string; value: string; onChange: (text: string) => void }) {
  return (
    <View className={cn('border-foreground flex-row items-center gap-2 rounded-[10px] border px-3', pick('h-12', 'h-[52px]'))}>
      <Input
        aria-labelledby="limit-label"
        accessibilityLabel={`${label} in sats`}
        keyboardType="number-pad"
        value={value}
        onChangeText={(t) => {
          const digits = t.replace(/\D/g, '');
          onChange(digits ? formatSats(Number(digits)) : '');
        }}
        className="h-full flex-1 border-0 bg-transparent px-0 text-lg font-medium tabular-nums focus-visible:ring-0"
      />
      <Text className="text-muted-foreground text-[15px]">sats</Text>
    </View>
  );
}

export default function DailyLimitSettings() {
  const state = useWallet();
  return limitIsOff(state) ? <LimitOff /> : <LimitOn />;
}

/** The limit is on: change it, or (a quiet link at the bottom) turn it off. */
function LimitOn() {
  const router = useRouter();
  const wallet = useWalletService();
  const state = useWallet();
  const { dailyLimit, hardware } = state;
  const current = dailyLimit.limitSats;
  const [text, setText] = useState(formatSats(current));
  const { busy, run, message, error } = useAction();

  const next = Number(text.replace(/\D/g, ''));
  const changed = next > 0 && next !== current;
  const needsHardware = limitChangeNeedsHardware(current, next);

  const save = async () => {
    const r = await run(wallet.setDailyLimit(next));
    if (r.ok) router.back();
  };

  return (
    <Screen
      title="Daily limit"
      backLabel="Settings"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton
            title={busy ? `Waiting for your ${hardware.brand}…` : needsHardware || !changed ? `Approve on ${hardware.brand}` : 'Save'}
            busy={busy}
            disabled={!changed}
            onPress={save}
          />
        </>
      }>
      <Body>How much you can send in 24 hours with just your phone. Your guardian enforces it.</Body>
      <View className="gap-1.5">
        <FieldLabel nativeID="limit-label">New limit</FieldLabel>
        <LimitField label="New daily limit" value={text} onChange={setText} />
        <Footnote>Now: {formatSats(current)} sats</Footnote>
      </View>
      {changed && !needsHardware ? (
        <Notice icon={Smartphone} title="Lowering it works from your phone">
          A lower limit only makes the rules stricter, so this phone can set it without your {hardware.brand}.
        </Notice>
      ) : (
        <Notice icon={HardwareWallet} title={`Raising it needs your ${hardware.brand}`}>
          So a stolen phone can never loosen the rules. Lowering the limit works from the phone alone.
        </Notice>
      )}
      {/* "No daily limit" is a link, not a button: only for a guardian that can do it, and not while a recovery runs. */}
      {canOfferLimitOff(state) ? <QuietLink title="Turn off the daily limit" disabled={busy} onPress={() => router.push('/settings/limit-off')} /> : null}
    </Screen>
  );
}

/** There is no daily limit: say what that means, and turn it back on from the phone alone. */
function LimitOff() {
  const router = useRouter();
  const wallet = useWalletService();
  const { dailyLimit, hardware } = useWallet();
  const [text, setText] = useState(formatSats(limitToRestore(dailyLimit)));
  const { busy, run, message, error } = useAction();
  const next = Number(text.replace(/\D/g, ''));

  const turnOn = async () => {
    const r = await run(wallet.setDailyLimit(next));
    if (r.ok) router.back();
  };

  return (
    <Screen
      title="Daily limit"
      backLabel="Settings"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton title="Turn the limit back on" busy={busy} disabled={!(next > 0)} onPress={turnOn} />
        </>
      }>
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn" title="No daily limit">
        Your phone and your guardian together can send everything, with just {pick('Face ID', 'your fingerprint')}. If someone
        gets into your phone, they can empty your wallet before you notice.
      </Notice>
      <View className="gap-1.5">
        <FieldLabel nativeID="limit-label">Limit</FieldLabel>
        <LimitField label="Daily limit" value={text} onChange={setText} />
        {dailyLimit.limitBeforeOffSats ? <Footnote>Before you turned it off: {formatSats(dailyLimit.limitBeforeOffSats)} sats</Footnote> : null}
      </View>
      <Notice icon={Smartphone} title="Works from your phone">
        Turning the limit back on only makes the rules stricter, so this phone can do it without your {hardware.brand}, at once.
      </Notice>
    </Screen>
  );
}
