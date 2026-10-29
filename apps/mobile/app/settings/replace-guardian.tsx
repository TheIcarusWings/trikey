import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice, ComingLater } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, Clock, Shield, TriangleAlert } from '@/components/icons';
import { Body, Footnote, InfoRow, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { WalletServiceError, formatSats, useWallet, useWalletService, type ReplaceGuardianResult, type ReplaceStep } from '@/data';
import { guardianBox, hostLabel } from '@/lib/labels';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

const ORDER: ReplaceStep[] = ['pair', 'sign', 'broadcast', 'retire', 'switch'];

/** One numbered step: a number before it starts, a spinner-free "now" while it runs, a check once done. */
function Step({ n, title, detail, state }: { n: number; title: string; detail?: string; state: 'todo' | 'now' | 'done' }) {
  return (
    <View className={cn('flex-row items-start', pick('gap-3', 'gap-4'))}>
      {state === 'done' ? (
        <View className="bg-good-soft size-7 shrink-0 items-center justify-center rounded-full">
          <Icon as={Check} size={15} className="text-good" strokeWidth={2.4} />
        </View>
      ) : (
        <View className={cn('size-7 shrink-0 items-center justify-center rounded-full border', state === 'now' ? 'border-foreground border-[1.5px]' : 'border-border')}>
          <Text className="text-[13px] font-semibold">{n}</Text>
        </View>
      )}
      <View className="flex-1 gap-0.5">
        <Text className={cn(pick('text-base leading-[22px]', 'text-base leading-6'), state === 'now' ? 'font-semibold' : 'font-medium')}>{title}</Text>
        {detail ? <Text className="text-muted-foreground text-sm leading-5">{detail}</Text> : null}
      </View>
    </View>
  );
}

/**
 * Settings > Guardian > Replace guardian: scan the new guardian's pairing code, see what will happen in plain steps,
 * confirm (and, if the old guardian does not answer, confirm it is gone for good), then follow the move step by step.
 * A move that could not be sent yet, or was interrupted, is picked up here again.
 */
export default function ReplaceGuardian() {
  const router = useRouter();
  const wallet = useWalletService();
  const { hardware, capabilities, replace, guardian, progress, oldWallets } = useWallet();
  const { busy, run, message, error, clear } = useAction();
  const [gone, setGone] = useState(false);
  const [result, setResult] = useState<ReplaceGuardianResult | null>(null);

  const start = async () => {
    clear();
    const r = await run(wallet.replaceGuardian({ oldGuardianGone: gone || replace.pending?.oldGuardianOffline }));
    if (r.ok) setResult(r.value);
  };

  // -- the move finished -------------------------------------------------
  if (result?.status === 'done') {
    return (
      <Screen
        title="Guardian replaced"
        backLabel="Guardian"
        footer={
          <AppButton
            title="Go to home"
            onPress={() => {
              router.dismissAll();
              router.replace('/home');
            }}
          />
        }>
        <View className="bg-good-soft size-[72px] items-center justify-center self-center rounded-full">
          <Icon as={Check} size={36} className="text-good" strokeWidth={2.4} />
        </View>
        <Text role="heading" aria-level={1} className={cn('text-center font-semibold tracking-[-0.6px]', pick('text-[30px] leading-9', 'text-[28px] leading-9'))}>
          Your money moved
        </Text>
        <Body className="text-center">
          {formatSats(result.movedSats)} sats are in your new wallet, guarded by {guardianBox(guardian)}. Your phone and {hardware.brand} are the same.
        </Body>
        <Panel>
          <InfoRow plainLabel label="New guardian" value={guardianBox(guardian)} tone="good" />
          <InfoRow plainLabel label="Old wallet" value={result.oldWalletRetired ? 'Retired on the old guardian' : 'Not retired yet'} tone={result.oldWalletRetired ? 'muted' : 'warn'} />
        </Panel>
        {result.oldWalletRetired ? null : (
          <Footnote>Your old guardian was offline, so it still knows the old wallet. Its key alone can't move anything. When it is back, retire the old wallet from Settings, Guardian.</Footnote>
        )}
      </Screen>
    );
  }

  // -- a move is running, or started and waits -----------------------------
  const plan = replace.plan;
  const running = busy && !!replace.step;
  const pending = replace.pending;
  if (running || pending || result?.status === 'waiting') {
    const at = replace.step ? ORDER.indexOf(replace.step) : pending?.signed ? 2 : 1;
    const waiting = !busy && (result?.status === 'waiting' || pending?.signed);
    const titles: Record<ReplaceStep, string> = {
      pair: 'Pair the new guardian',
      sign: `Sign the move on your ${hardware.brand}`,
      broadcast: 'Send it to the network',
      retire: 'Retire the old wallet',
      switch: 'Switch to the new wallet',
    };
    return (
      <Screen
        title="Moving to the new guardian"
        backLabel="Guardian"
        footer={
          <>
            <ActionNotice message={message} error={error} />
            {busy ? null : <AppButton title={waiting ? 'Try sending it again' : 'Go on with the move'} onPress={() => void start()} />}
            {!busy && pending && !pending.signed ? (
              <AppButton title="Cancel the move" variant="ghost" onPress={() => void run(wallet.cancelReplaceGuardian())} />
            ) : null}
          </>
        }>
        <Body>{busy ? (progress ?? 'Working…') : waiting ? 'The move is signed and kept on this phone.' : `The move to ${pending?.guardianLabel ?? 'the new guardian'} has started.`}</Body>
        <View className={pick('gap-3.5', 'gap-4')}>
          {ORDER.map((step, i) => (
            <Step key={step} n={i + 1} title={titles[step]} state={i < at ? 'done' : i === at && busy ? 'now' : 'todo'} />
          ))}
        </View>
        {waiting ? (
          <Notice icon={Clock} tone="fill" title="Waiting for a way to send it">
            Your old guardian is offline, and it is the node that can send this move to the network. Your money is safe where it is. Try again once the old
            guardian is back online.
          </Notice>
        ) : null}
        {busy ? <Footnote>Keep the app open. Approve on your {hardware.brand} when it asks.</Footnote> : null}
      </Screen>
    );
  }

  // -- after scanning: what will happen -------------------------------------
  if (plan) {
    // Also when it stopped answering between the scan and the start.
    const needsConfirm = !plan.oldGuardianReachable || (error instanceof WalletServiceError && error.kind === 'guardian_unreachable');
    return (
      <Screen
        title="Replace guardian"
        backLabel="Guardian"
        footer={
          <>
            <ActionNotice message={message} error={error} />
            <AppButton title="Start the move" busy={busy} disabled={needsConfirm && !gone} onPress={() => void start()} />
            <AppButton title="Cancel" variant="ghost" onPress={() => void wallet.cancelReplaceGuardian().then(() => router.back())} />
          </>
        }>
        <Body>Here is what happens. Your phone and {hardware.brand} stay the same; the new guardian gets a new wallet with them.</Body>
        <Panel>
          <InfoRow plainLabel label="New guardian" value={plan.newGuardian.label ?? hostLabel(plan.newGuardian.host)} />
          <InfoRow plainLabel label="Moving" value={`${formatSats(plan.movingSats)} sats`} tabular />
          <InfoRow plainLabel label="Network fee" value={plan.coins ? `about ${formatSats(plan.feeSats)} sats` : 'None'} tabular />
        </Panel>
        <View className={pick('gap-3.5', 'gap-4')}>
          {plan.steps.map((s, i) => (
            <Step key={s.step} n={i + 1} title={s.text} state="todo" />
          ))}
        </View>
        {needsConfirm ? (
          <View className="gap-3">
            <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn-outline" title="Your old guardian isn't answering">
              If it is only off for a moment, turn it on and try again: it sends the move and retires the old wallet. If it is gone for good, the move
              goes ahead without it.
            </Notice>
            <View className="min-h-14 flex-row items-center justify-between gap-4">
              <Text nativeID="gone-label" className="flex-1 text-base leading-6">
                My old guardian is gone for good
              </Text>
              <Switch checked={gone} onCheckedChange={setGone} aria-labelledby="gone-label" accessibilityLabel="My old guardian is gone for good" />
            </View>
          </View>
        ) : null}
      </Screen>
    );
  }

  // -- the start: how it works ---------------------------------------------
  const steps = [
    { title: 'Install Trikey Guardian on the new box', detail: 'Umbrel or Start9' },
    { title: 'Scan its pairing code', detail: 'Trikey shows you every step before anything moves' },
    { title: `Approve the move on your ${hardware.brand}`, detail: 'One transaction, with a network fee' },
  ];
  return (
    <Screen
      title="Replace guardian"
      backLabel="Guardian"
      footer={
        <AppButton
          title="Scan new guardian"
          disabled={!capabilities.replaceGuardian}
          onPress={() => router.push({ pathname: '/scan-guardian', params: { replace: '1' } })}
        />
      }>
      <Body>
        For a new home server, or if the old one died. Your money moves once to a new wallet with the same phone and hardware wallet. No
        waiting period.
      </Body>
      <View className={pick('gap-3.5', 'gap-4')}>
        {steps.map((step, i) => (
          <Step key={step.title} n={i + 1} title={step.title} detail={step.detail} state="todo" />
        ))}
      </View>
      {capabilities.replaceGuardian ? null : (
        <ComingLater>
          Replacing the guardian isn't built into this version yet. Your money stays where it is. If your guardian is lost, the recovery flows still
          work.
        </ComingLater>
      )}
      {oldWallets.length ? <Footnote>You replaced a guardian before. Its old wallet is listed under Settings, Guardian.</Footnote> : null}
      <Notice icon={Shield}>After the move, the old guardian's key is useless, even if someone finds the old box.</Notice>
    </Screen>
  );
}
