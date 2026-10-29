import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check } from '@/components/icons';
import { Body, Footnote, InfoRow, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { useSilentPayments } from '@/components/silent-payments';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatSats } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

type Moved = { moved: number; movedSats: number; feeSats: number; waiting: number; failed: number; message?: string };

/**
 * "Move into your vault": what was received at the silent payment address goes into the vault, one transaction for each
 * payment (never joined, so the payments stay unlinked), each to its own vault address, with the fee shown first. One tap
 * and one Face ID for all of them. The wallet never does this by itself: it needs the phone key, and the person chooses when
 * the fee is acceptable.
 */
export default function MoveSilentPayments() {
  const router = useRouter();
  const { sp, actions, state } = useSilentPayments();
  const { busy, run, message, error } = useAction();
  const [done, setDone] = useState<Moved | null>(null);
  const plan = sp.move;
  const waiting = plan.coins.filter((c) => c.waiting);

  if (done) {
    return (
      <Screen bare scrollable={false} gap={12} footer={<AppButton title="Done" onPress={() => router.dismissTo('/home')} />}>
        <View className="flex-1 items-center justify-center gap-3">
          <View className="bg-good-soft size-[72px] items-center justify-center rounded-full">
            <Icon as={Check} size={36} className="text-good" strokeWidth={2.4} />
          </View>
          <Text role="heading" aria-level={1} className={cn('mt-2 text-center', pick('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', 'text-[28px] font-semibold leading-9 tracking-[-0.56px]'))}>
            {done.moved > 0 ? 'Moved' : 'Nothing moved'}
          </Text>
          {done.moved > 0 ? (
            <Text className={cn('text-center', pick('text-[17px] leading-6', 'text-base leading-6'))}>
              <Text className="tabular-nums">{formatSats(done.movedSats)} sats</Text> from {done.moved} {done.moved === 1 ? 'payment' : 'payments'} are on their way into your vault.
            </Text>
          ) : null}
          {done.failed > 0 ? <Notice tone="warn-outline">{done.message ?? 'Some payments could not be sent. They are still yours; try again in a moment.'}</Notice> : null}
          {done.waiting > 0 ? <Footnote className="text-center">{done.waiting} too small for today's fee: they wait for a cheaper one.</Footnote> : null}
        </View>
      </Screen>
    );
  }

  const move = async () => {
    const r = await run(actions!.move());
    if (r.ok) setDone(r.value);
  };

  return (
    <Screen
      title="Move into your vault"
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton
            title={busy ? 'Moving…' : plan.ready === 0 ? 'Nothing to move yet' : `${pick('Move with Face ID', 'Move with fingerprint')}`}
            busy={busy}
            disabled={plan.ready === 0 || state.guardian.status === 'offline'}
            onPress={() => void move()}
          />
        </>
      }>
      <Body>Each payment moves in its own transaction, to its own vault address, so nothing joins them together.</Body>
      {plan.coins.length === 0 ? (
        <Notice tone="fill">No silent payments are waiting.</Notice>
      ) : (
        <>
          <Panel>
            {plan.coins.map((c) => (
              <InfoRow
                key={c.id}
                label={`${formatSats(c.valueSats)} sats`}
                value={c.waiting ? 'Too small for the fee now' : `${formatSats(c.netSats)} after a ${formatSats(c.feeSats)} fee`}
                tone={c.waiting ? 'muted' : 'default'}
                tabular
              />
            ))}
          </Panel>
          <Panel>
            <InfoRow label="Network fees" value={`${formatSats(plan.totalFeeSats)} sats`} tabular />
            <InfoRow label="Into your vault" value={`${formatSats(plan.totalNetSats)} sats`} strong tabular />
          </Panel>
          <Footnote>
            Fees are about {plan.feeRateSatPerVb} sat/vB right now. {waiting.length > 0 ? 'Payments too small to cover their fee wait until fees are lower. ' : ''}
            Until you move them, these payments sit on this phone, behind your Face ID; they are not in the vault's protection yet.
          </Footnote>
        </>
      )}
    </Screen>
  );
}
