import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { TriangleAlert } from '@/components/icons';
import { Body, FieldLabel, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Input } from '@/components/ui/input';
import { useWallet, useWalletService } from '@/data';
import { useAction } from '@/lib/use-action';

/** What the person types to remove the wallet: a typed word, not a tap, for a step that deletes the phone key. */
export const REMOVE_WORD = 'REMOVE';

/**
 * Settings > Remove this wallet. Was under Developer (test builds only, since 2026-11-19); people need it in every build
 * to start over, or to hand the phone on. It deletes this phone's key and data, never the money: the coins stay on chain,
 * and the backup (recovery code plus file, or passkey) or a recovery brings the wallet back.
 */
export default function RemoveWallet() {
  const router = useRouter();
  const wallet = useWalletService();
  const { backup, hardware } = useWallet();
  const [typed, setTyped] = useState('');
  const { busy, run, message, error } = useAction();
  const forget = wallet.dev?.forgetWallet;
  const backedUp = !!backup?.lastBackedUpAt;

  return (
    <Screen
      title="Remove this wallet"
      backLabel="Settings"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton
            title="Remove wallet"
            variant="destructive"
            busy={busy}
            disabled={!forget || typed.trim().toUpperCase() !== REMOVE_WORD}
            onPress={async () => {
              const r = await run(forget!());
              if (r.ok) {
                router.dismissAll();
                router.replace('/welcome');
              }
            }}
          />
        </>
      }>
      <Body>
        This deletes this phone's key and the wallet's data from this phone. Your money isn't touched: it stays on the bitcoin network, guarded as
        before.
      </Body>
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn" title={backedUp ? 'You need your backup to come back' : 'Make a backup first'}>
        {backedUp
          ? `To use this wallet again, on this phone or another, you need the backup file and its recovery code, or your passkey. Without them, only a recovery with your ${hardware.brand} gets the money back.`
          : `This wallet has no backup yet. Without one, only a recovery with your ${hardware.brand} gets the money back: make a backup in Settings first.`}
      </Notice>
      <FieldLabel nativeID="remove-word">{`Type ${REMOVE_WORD} to confirm`}</FieldLabel>
      <Input
        aria-labelledby="remove-word"
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="characters"
        autoCorrect={false}
        accessibilityLabel={`Type ${REMOVE_WORD} to confirm`}
      />
    </Screen>
  );
}
