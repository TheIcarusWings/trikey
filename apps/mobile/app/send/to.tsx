import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check, ClipboardPaste, QrCode } from '@/components/icons';
import { FieldLabel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { looksLikeBitcoinAddress, looksLikeSilentPaymentAddress, useWallet, useWalletService } from '@/data';
import { QrScanner } from '@/hardware/ui';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/** Demo address the mock "scanner" returns until the camera is wired up. */
const DEMO_ADDRESS = 'tb1q9d4xe8w2m5ka3hq7l0pz6vtrc2yn7kmr';

/** Step 1 of a payment: who it goes to. The amount comes next, on its own screen. */
export default function SendTo() {
  const router = useRouter();
  const state = useWallet();
  const wallet = useWalletService();
  const { vault } = useLocalSearchParams<{ vault?: string }>();
  const fromVault = vault === '1';
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState<string | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [scanProblem, setScanProblem] = useState<string | null>(null);

  const trimmed = address.trim();
  const ok = looksLikeBitcoinAddress(trimmed);
  const bad = trimmed.length > 0 && !ok;
  const silent = looksLikeSilentPaymentAddress(trimmed);

  const paste = async () => {
    const text = (await Clipboard.getStringAsync()).trim();
    if (!text) return;
    // A pasted BIP 21 link brings its amount along, as a scanned one does.
    const code = wallet.readCode(text);
    if (code.kind === 'address') {
      setAddress(code.address);
      setAmount(code.amountSats ? String(code.amountSats) : undefined);
    } else setAddress(text);
  };

  const next = () =>
    router.push({ pathname: '/send/amount', params: { address: trimmed, ...(amount ? { amount } : {}), ...(fromVault ? { vault: '1' } : {}) } });

  return (
    <Screen title={fromVault ? 'Pay from vault' : 'Send to'} backLabel="Home" footer={<AppButton title="Continue" disabled={!ok} onPress={next} />}>
      <View className="gap-1.5">
        <FieldLabel nativeID="send-to">Bitcoin address</FieldLabel>
        <Input
          aria-labelledby="send-to"
          accessibilityLabel="Bitcoin or silent payment address"
          placeholder="Bitcoin or silent payment address"
          value={address}
          onChangeText={(text) => {
            setAddress(text);
            setAmount(undefined);
          }}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          textAlignVertical="top"
          className={cn('h-auto min-h-[76px] py-3 font-mono text-base leading-[26px]', bad && 'border-destructive')}
        />
        {bad ? <Text className="text-destructive text-[13px] leading-[18px]">That doesn't look like a bitcoin address.</Text> : null}
        {ok ? (
          <View className="flex-row items-center gap-1.5">
            <Icon as={Check} size={14} strokeWidth={2.4} className="text-good" />
            <Text className="text-good text-[13px] leading-[18px]">
              {silent ? 'Silent payment address: a small helper coin of this phone pays part of the fee' : 'Bitcoin address'}
            </Text>
          </View>
        ) : null}
      </View>
      <View className="flex-row gap-3">
        <AppButton title="Paste" icon={ClipboardPaste} variant={pick('secondary', 'outline')} className="flex-1 self-auto" onPress={() => void paste()} />
        <AppButton
          title="Scan QR code"
          icon={QrCode}
          variant={pick('secondary', 'outline')}
          className="flex-1 self-auto"
          onPress={() => (state.backing === 'demo' ? setAddress(DEMO_ADDRESS) : setScanning((v) => !v))}
        />
      </View>
      {scanning ? (
        <View className="gap-2">
          <QrScanner
            size={220}
            onFrame={(data) => {
              // A plain address or a BIP 21 link (with its amount); anything else says what it is.
              const code = wallet.readCode(data);
              if (code.kind === 'address') {
                setAddress(code.address);
                setAmount(code.amountSats ? String(code.amountSats) : undefined);
                setScanProblem(null);
                setScanning(false);
              } else setScanProblem(code.kind === 'unknown' ? code.reason : "That code isn't a bitcoin or silent payment address.");
            }}
          />
          {scanProblem ? <Text className="text-destructive text-[13px] leading-[18px]">{scanProblem}</Text> : null}
          <AppButton title="Close camera" variant="ghost" onPress={() => setScanning(false)} />
        </View>
      ) : null}
    </Screen>
  );
}
