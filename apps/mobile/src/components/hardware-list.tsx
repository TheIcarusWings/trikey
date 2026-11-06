import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { NFC_MODELS, NFC_MODEL_INFO, QR_MODELS, isNfcModel, qrModelInfo } from '@trikey/wallet';
import { AppButton } from '@/components/app-button';
import { ChevronRight, Info } from '@/components/icons';
import { Body, ListGroup, Notice } from '@/components/panels';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useWalletService, type HardwareKind, type HardwareOption, type QrModel } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * What the device will be used for. `guardian`: a guardian wallet, where the device must sign Trikey's texts (pairing,
 * approvals, recovery access), so a QR model that cannot is stopped before anything starts. `payments`: it only
 * co-signs payments (Recovery Key mode, Savings), which every QR model with a camera does.
 */
export type HardwarePurpose = 'guardian' | 'payments';

function Row({ title, detail, label, disabled, onPress }: { title: string; detail: string; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      role="link"
      disabled={disabled}
      accessibilityLabel={label}
      onPress={onPress}
      className={cn(
        'flex-row items-center gap-3 active:bg-accent',
        pick('min-h-[60px] px-4 py-3', 'min-h-[72px] gap-4 px-0 py-3'),
        disabled && 'opacity-50'
      )}>
      <View className="flex-1">
        <Text className={pick('text-[17px] leading-[22px]', 'text-base leading-6')}>{title}</Text>
        <Text className={cn('text-muted-foreground', pick('text-[13px] leading-[18px]', 'text-sm leading-5'))}>{detail}</Text>
      </View>
      <Icon as={ChevronRight} size={pick(20, 24)} className={IS_IOS ? 'text-chevron' : 'text-muted-foreground'} strokeWidth={2} />
    </Pressable>
  );
}

/** Why `model` can't be used for `purpose`, or undefined when it can. */
export function qrModelBlock(model: QrModel, purpose: HardwarePurpose): { title: string; text: string; payments: boolean } | undefined {
  const info = qrModelInfo(model);
  if (!info.qr) return { title: `${info.name}: not by QR code`, text: info.whyNot ?? '', payments: false };
  if (purpose === 'guardian' && !info.signsMessages)
    return {
      title: `${info.name} can't set up a guardian wallet yet`,
      text: `It can co-sign payments, but a guardian wallet needs your hardware wallet to sign a short text to pair with your guardian and to approve rule changes. ${info.whyNot ?? ''}`.trim(),
      payments: true,
    };
  return undefined;
}

/**
 * The QR device models (@trikey/wallet qr-devices.ts), each with what it can do. Picking one that cannot do `purpose`
 * says so before anything starts, and offers Recovery Key mode where the caller has it (`onRecoveryKeyMode`).
 */
export function QrModelList({
  purpose,
  onPick,
  onRecoveryKeyMode,
  onNfc,
  current,
}: {
  purpose: HardwarePurpose;
  onPick: (model: QrModel) => void;
  onRecoveryKeyMode?: () => void;
  /** A Coldcard with no camera (the Mk4) picked here goes to NFC instead, when this phone has it. */
  onNfc?: (model: QrModel) => void;
  current?: QrModel;
}) {
  const [blocked, setBlocked] = useState<QrModel | null>(null);
  const block = blocked ? qrModelBlock(blocked, purpose) : undefined;
  if (blocked && block)
    return (
      <View className="gap-3">
        <Notice icon={Info} tone="warn-outline" title={block.title}>
          {block.text}
          {block.payments && onRecoveryKeyMode ? ' Recovery Key mode needs no guardian, so you can use it there.' : ''}
        </Notice>
        {block.payments && onRecoveryKeyMode ? <AppButton title="Use Recovery Key mode instead" onPress={onRecoveryKeyMode} /> : null}
        <AppButton title="Pick another device" variant="outline" onPress={() => setBlocked(null)} />
      </View>
    );
  return (
    <ListGroup>
      {QR_MODELS.map((model) => {
        const info = qrModelInfo(model);
        const stop = qrModelBlock(model, purpose);
        const detail = model === current ? `${info.detail} · current` : info.detail;
        return (
          <Row
            key={model}
            title={info.name}
            detail={detail}
            label={`${info.name}. ${detail}`}
            onPress={() => (!info.qr && onNfc && isNfcModel(model) ? onNfc(model) : stop ? setBlocked(model) : onPick(model))}
          />
        );
      })}
    </ListGroup>
  );
}

/**
 * The hardware wallets this phone can talk to (Ledger, Trezor, a Coldcard over NFC, QR devices; the simulated device in
 * the simulator), asked of the wallet. Used when connecting the first one and when connecting a replacement. "Scan a QR
 * code" opens the list of QR models: the owner picks theirs, since it decides whether the device can set up a guardian
 * wallet. "Coldcard by NFC" asks which Coldcard (Mk4 or Q); a Coldcard Mk4 picked among the QR models goes there too.
 */
export function HardwareList({
  onPick,
  purpose = 'payments',
  onRecoveryKeyMode,
}: {
  onPick: (kind: HardwareKind, qrModel?: QrModel) => void;
  purpose?: HardwarePurpose;
  onRecoveryKeyMode?: () => void;
}) {
  const wallet = useWalletService();
  const [options, setOptions] = useState<HardwareOption[] | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [nfcOpen, setNfcOpen] = useState(false);

  useEffect(() => {
    let off = false;
    void wallet.getHardwareOptions().then((o) => !off && setOptions(o));
    return () => {
      off = true;
    };
  }, [wallet]);

  if (!options) return <Body>Looking for what this phone can connect to…</Body>;
  if (options.length === 0)
    return (
      <Body>
        This device can't connect to a hardware wallet. Open the app on a phone, or switch to the Demo or the Simulator in Settings, Developer.
      </Body>
    );

  const nfc = options.find((o) => o.kind === 'coldcard-nfc');

  if (nfcOpen)
    return (
      <View className="gap-3">
        <Body>Which Coldcard is it? Both talk to this phone over NFC: you hold the phone to the Coldcard for each step.</Body>
        <ListGroup>
          {NFC_MODELS.map((model) => {
            const info = NFC_MODEL_INFO[model];
            return <Row key={model} title={info.name} detail={info.detail} label={`${info.name}. ${info.detail}`} onPress={() => onPick('coldcard-nfc', model)} />;
          })}
        </ListGroup>
        <AppButton title="Back to all devices" variant="ghost" onPress={() => setNfcOpen(false)} />
      </View>
    );

  if (qrOpen)
    return (
      <View className="gap-3">
        <Body>Which device is it? Trikey asks it for different things, and not every device can set up a guardian wallet.</Body>
        <QrModelList
          purpose={purpose}
          onPick={(model) => onPick('qr', model)}
          onRecoveryKeyMode={onRecoveryKeyMode}
          onNfc={nfc?.available ? (model) => onPick('coldcard-nfc', model) : undefined}
        />
        <AppButton title="Back to all devices" variant="ghost" onPress={() => setQrOpen(false)} />
      </View>
    );

  return (
    <ListGroup>
      {options.map((option) => {
        const unavailable = option.unavailableDetail ?? 'Not available on this phone right now';
        return (
          <Row
            key={option.kind}
            title={option.name}
            detail={option.available ? option.detail : unavailable}
            label={`${option.name}. ${option.detail}${option.available ? '' : `. ${unavailable}`}`}
            disabled={!option.available}
            onPress={() => (option.kind === 'qr' ? setQrOpen(true) : option.kind === 'coldcard-nfc' ? setNfcOpen(true) : onPick(option.kind))}
          />
        );
      })}
    </ListGroup>
  );
}
