import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Input } from '@/components/ui/input';
import { useWalletService } from '@/data';
import { useAction } from '@/lib/use-action';
import { pick } from '@/lib/platform';

/**
 * The passphrase field that unlocks a guardian after a restart. The passphrase lives in this component's state for as
 * long as the field is on screen, goes to the guardian once, and is cleared as soon as the guardian answers. It is never
 * written anywhere.
 */
export function UnlockForm({ onUnlocked }: { onUnlocked?: () => void }) {
  const wallet = useWalletService();
  const [passphrase, setPassphrase] = useState('');
  const { busy, run, message, error, clear } = useAction();

  const submit = async () => {
    const typed = passphrase;
    const r = await run(wallet.unlockGuardian(typed));
    setPassphrase('');
    if (r.ok) onUnlocked?.();
  };

  return (
    <View className="gap-3">
      <Input
        accessibilityLabel="Guardian passphrase"
        placeholder="Guardian passphrase"
        value={passphrase}
        onChangeText={(t) => {
          setPassphrase(t);
          if (message) clear();
        }}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        textContentType="none"
        importantForAutofill="no"
        returnKeyType="go"
        onSubmitEditing={() => passphrase && !busy && void submit()}
        editable={!busy}
        className={pick('h-11', 'h-12')}
      />
      <ActionNotice message={message} error={error} />
      <AppButton
        title={busy ? 'Unlocking…' : 'Unlock guardian'}
        busy={busy}
        disabled={passphrase.length === 0}
        onPress={() => void submit()}
      />
    </View>
  );
}
