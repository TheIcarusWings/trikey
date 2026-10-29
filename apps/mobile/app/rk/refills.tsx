import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Lock } from '@/components/icons';
import { Body, Footnote, Notice } from '@/components/panels';

import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { errorText, formatSats, formatShortDate, groupAddress, useWallet, useWalletService, type RefillPreview } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

function ScheduleRow({ label, amount, muted, strong, last }: { label: string; amount: number; muted?: boolean; strong?: boolean; last?: boolean }) {
  return (
    <View className={cn('flex-row items-center justify-between', pick('min-h-11', 'min-h-12'), !last && 'border-border border-b')}>
      <Text className={cn('text-[15px]', muted && 'text-muted-foreground', strong && 'font-semibold')}>{label}</Text>
      <Text className={cn('text-[15px] tabular-nums', muted && 'text-muted-foreground', strong && 'font-semibold')}>{formatSats(amount)}</Text>
    </View>
  );
}

/** How long a typed amount or count rests before the preview is worked out again. */
const SETTLE_MS = 300;

/**
 * Approve a batch of chained, time-locked refills with the hardware wallet. Reached from Recovery Key set-up (first time,
 * `?first=1`) and from the vault card on home (more refills later, which continue the chain that is running).
 */
export default function RecoveryKeyRefills() {
  const router = useRouter();
  const wallet = useWalletService();
  const { first } = useLocalSearchParams<{ first?: string }>();
  const { recoveryKey, hardware, backing } = useWallet();
  const [amount, setAmount] = useState(recoveryKey.refillAmountSats);
  const [count, setCount] = useState(recoveryKey.refillCount);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<RefillPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const { busy, run, message, error } = useAction();
  const rk = wallet.rk!;

  // Worked out again once the amount or count has rested: it reads the chain and the vault's coins.
  useEffect(() => {
    let off = false;
    const timer = setTimeout(
      () => {
        rk.previewRefills({ amountSats: amount, count }).then(
          (p) => {
            if (off) return;
            setPreview(p);
            setPreviewError(null);
            // The vault can pay for fewer than were asked: show what is possible, not what was typed.
            if (p.count !== count) setCount(p.count);
            // Extending the running chain keeps its amount.
            if (p.mode === 'extend' && p.amountSats !== amount) setAmount(p.amountSats);
          },
          (e) => {
            if (!off) setPreviewError(errorText(e));
          },
        );
      },
      preview ? SETTLE_MS : 0,
    );
    return () => {
      off = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, count, nonce]);

  // Waiting for a deposit to confirm: look again every so often. (The preview reads the chain itself.)
  useEffect(() => {
    if (!previewError) return;
    const id = setInterval(() => setNonce((n) => n + 1), 20_000);
    return () => clearInterval(id);
  }, [previewError]);

  const approve = async () => {
    if (!preview) return;
    const r = await run(rk.approveRefills({ amountSats: preview.amountSats, count: preview.count }));
    if (!r.ok) return;
    if (first) {
      wallet.finishOnboarding('recoveryKey');
      router.dismissAll();
      router.replace('/home');
      return;
    }
    router.back();
  };

  const extend = preview?.mode === 'extend';
  const schedule = preview?.schedule ?? [];
  const head = schedule.slice(0, 3);
  const rest = schedule.slice(3);
  const label = (r: (typeof schedule)[number]) => `Refill ${r.index} · ${r.today ? 'today' : formatShortDate(r.at)}`;
  const lastDate = schedule.length ? schedule[schedule.length - 1]!.at : undefined;
  const brand = hardware.brand;
  const canApprove = !!preview && preview.count > 0 && !busy;

  return (
    <Screen
      title="Approve refills"
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton
            title={busy ? `Waiting for your ${brand}…` : `Approve on ${brand}`}
            busy={busy}
            disabled={!canApprove}
            onPress={approve}
          />
        </>
      }>
      <Body>
        {extend
          ? 'These refills continue the ones you already approved, at the same amount. Each one unlocks a week after the one before.'
          : 'Your phone can spend on its own from a small balance. Approve a few weeks of top-ups now, and each one unlocks on its date.'}
      </Body>
      <Card className="gap-3 px-4 py-3.5">
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-muted-foreground text-[13px] leading-[18px]">Each week</Text>
            {editing && !extend ? (
              <Input
                accessibilityLabel="Refill amount in sats"
                keyboardType="number-pad"
                value={formatSats(amount)}
                onChangeText={(text) => setAmount(Number(text.replace(/\D/g, '')))}
                className="mt-1 h-10 w-44 text-xl font-medium tabular-nums"
                autoFocus
              />
            ) : (
              <Text className={cn('text-xl leading-[26px] tabular-nums', pick('font-semibold', 'font-medium'))}>{formatSats(amount)} sats</Text>
            )}
          </View>
          {extend ? null : (
            <AppButton
              title={editing ? 'Done' : 'Change'}
              variant="outline"
              size="compact"
              disabled={editing && amount <= 0}
              onPress={() => setEditing((e) => !e)}
              className="self-auto"
            />
          )}
        </View>
        <View className="bg-border h-px" />
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-muted-foreground text-[13px] leading-[18px]">How many</Text>
            <Text className={cn('text-xl leading-[26px] tabular-nums', pick('font-semibold', 'font-medium'))} accessibilityLabel={`${count} refills`}>
              {count}
              {preview ? <Text className="text-muted-foreground text-[15px] font-normal"> of up to {preview.maxCount}</Text> : null}
            </Text>
          </View>
          <View className="flex-row gap-2">
            <AppButton title="−" accessibilityLabel="Fewer refills" variant="outline" size="compact" disabled={count <= 1} className="w-11 self-auto" onPress={() => setCount((c) => Math.max(1, c - 1))} />
            <AppButton
              title="+"
              accessibilityLabel="More refills"
              variant="outline"
              size="compact"
              disabled={!!preview && count >= preview.maxCount}
              className="w-11 self-auto"
              onPress={() => setCount((c) => c + 1)}
            />
          </View>
        </View>
      </Card>
      {previewError ? (
        <View className="gap-3">
          <Notice tone="warn-outline" title={recoveryKey.vaultSats > 0 ? 'Waiting for your deposit' : 'Nothing to refill from yet'}>
            {recoveryKey.vaultSats > 0
              ? `${formatSats(recoveryKey.vaultSats)} sats are on their way to the vault. Refills can be planned once they confirm.`
              : `${previewError} Send some bitcoin to the vault's address, and come back when it has confirmed.`}
          </Notice>
          <Text className="font-mono text-[13px] leading-5" selectable testID="vault-address">
            {groupAddress(rk.vaultAddress())}
          </Text>
          <View className="flex-row gap-3">
            <AppButton title="Show QR code" variant="outline" size="compact" className="flex-1 self-auto" onPress={() => router.push({ pathname: '/receive', params: { to: 'vault' } })} />
            <AppButton
              title="Check again"
              variant="outline"
              size="compact"
              className="flex-1 self-auto"
              onPress={() => {
                void wallet.sync().then(() => setNonce((n) => n + 1));
              }}
            />
          </View>
          {first ? (
            <AppButton
              title="Skip for now"
              variant="ghost"
              onPress={() => {
                wallet.finishOnboarding('recoveryKey');
                router.dismissAll();
                router.replace('/home');
              }}
            />
          ) : null}
        </View>
      ) : null}
      {preview && preview.maxCount < 1 ? (
        <Notice tone="warn-outline" title="The vault is too small for this amount">
          A refill of {formatSats(preview.amountSats)} sats plus its fee does not fit in the {formatSats(preview.vaultSats)} sats the vault holds. Try a smaller amount.
        </Notice>
      ) : null}
      {preview && schedule.length > 0 ? (
        <View>
          <Text className="pb-1 text-sm font-medium leading-5">Schedule</Text>
          {head.map((r, i) => (
            <ScheduleRow key={r.index} label={label(r)} amount={r.amountSats} last={false} muted={false} strong={false} />
          ))}
          {rest.length > 0 ? (
            <ScheduleRow
              label={rest.length === 1 ? label(rest[0]!) : `Refills ${rest[0]!.index} to ${rest[rest.length - 1]!.index} · weekly to ${formatShortDate(lastDate!)}`}
              amount={rest.reduce((sum, r) => sum + r.amountSats, 0)}
              muted
            />
          ) : null}
          <ScheduleRow label={`Total over ${schedule.length} ${schedule.length === 1 ? 'week' : 'weeks'}`} amount={preview.totalSats} strong last />
        </View>
      ) : null}
      {preview ? (
        <Footnote>
          Each refill pays about {formatSats(preview.feePerRefillSats)} sats in network fees, taken from the vault. If fees rise, the phone can speed one up.
        </Footnote>
      ) : null}
      <Notice icon={Lock} tone="fill">
        Refills can only go to this phone, and none can arrive early. A thief with your phone gets one week at most.
      </Notice>
      {preview && preview.count > 0 ? (
        <Notice tone="outline" title={`${brand} will ask ${preview.confirmations} ${preview.confirmations === 1 ? 'time' : 'times'}`}>
          Once for each refill, with its amount on the screen. Then your phone asks for {pick('Face ID', 'your fingerprint')} once.{backing === 'demo' ? '' : ' Check each amount before you approve.'}
        </Notice>
      ) : null}
    </Screen>
  );
}
