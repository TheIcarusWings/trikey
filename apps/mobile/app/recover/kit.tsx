import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { ActionNotice, ComingLater } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { QrCode, TriangleAlert } from '@/components/icons';
import { Body, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { formatSats, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

function RecoveryStep({ n, active, title, detail }: { n: number; active?: boolean; title: string; detail: string }) {
  return (
    <View className={cn('flex-row items-center px-4', pick('gap-3 py-3.5', 'gap-4 py-4'))}>
      <View
        className={cn(
          'size-7 shrink-0 items-center justify-center rounded-full',
          active ? 'bg-primary' : 'border-border border'
        )}>
        <Text className={cn('text-sm font-semibold', active ? 'text-primary-foreground' : 'text-muted-foreground')}>{n}</Text>
      </View>
      <View className="flex-1">
        <Text className={cn('font-medium', pick('text-base leading-[22px]', 'text-base leading-6'))}>{title}</Text>
        <Text className="text-muted-foreground text-sm leading-5">{detail}</Text>
      </View>
    </View>
  );
}

/** Recovery Key mode recovery: scan the kit, connect the other key, sweep to a new wallet. */
export default function RecoverWithKit() {
  const router = useRouter();
  const wallet = useWalletService();
  const { hardware, balanceSats, capabilities } = useWallet();
  const { busy, run, message, error } = useAction();

  const scan = async () => {
    // The camera hands the kit's QR contents over; the mock needs nothing.
    const r = await run(wallet.recoverWithKit());
    if (r.ok) router.replace({ pathname: '/recover/done', params: { moved: String(r.value.movedSats) } });
  };

  return (
    <Screen
      title="Recover with your Recovery Kit"
      androidTitle="Recover with your kit"
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton title="Scan Recovery Kit" icon={QrCode} busy={busy} disabled={!capabilities.recoveryKey} onPress={scan} />
        </>
      }>
      {capabilities.recoveryKey ? null : <ComingLater>Recovery Kits belong to Recovery Key mode, which has no wallet code behind it yet.</ComingLater>}
      <Body>
        Your kit plus the device you still have make two of three keys. Your money moves to a fresh wallet right away, with no waiting.
      </Body>
      <Panel>
        <RecoveryStep n={1} active title="Scan your Recovery Kit" detail="The QR code on the printed sheet" />
        <RecoveryStep n={2} title={`Connect your ${hardware.brand}`} detail={`Or use this phone if the ${hardware.brand} is gone`} />
        <RecoveryStep n={3} title="Move to a new wallet" detail={`${formatSats(balanceSats)} sats · then print a new kit`} />
      </Panel>
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn">
        There's no waiting period here, so the kit must never sit next to your phone or your seed words.
      </Notice>
    </Screen>
  );
}
