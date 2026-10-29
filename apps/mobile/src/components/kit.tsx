import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { FileText, QrCode, TriangleAlert } from '@/components/icons';
import { Body, FieldLabel, Footnote, InfoRow, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { networkLabel, type KitProof, type RecoveryKit } from '@/data';
import { QrScanner } from '@/hardware/ui';
import { pick } from '@/lib/platform';
import { printKit } from '@/lib/print-kit';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

/**
 * The one rule of the Recovery Kit, said so it cannot be missed: a heavy red border, the key's name in the title, and the
 * consequence in plain words (no waiting period, no undo).
 */
export function KeepApartNotice({ hardwareBrand }: { hardwareBrand: string }) {
  return (
    <View accessibilityRole="alert" className="bg-warn-soft border-destructive flex-row items-start gap-3 rounded-xl border-2 px-4 py-4">
      <Icon as={TriangleAlert} size={24} className="text-destructive mt-px" strokeWidth={2} />
      <View className="flex-1 gap-1.5">
        <Text className="text-[17px] font-semibold leading-[22px]">This sheet holds a key</Text>
        <Text className="text-sm leading-5">
          Anyone with this sheet and your phone, or this sheet and your {hardwareBrand}, can take all your money. There is no waiting period and no undo.
        </Text>
        <Text className="text-sm font-medium leading-5">
          Keep it apart from your phone and from your {hardwareBrand}'s seed words, in a place only you can reach.
        </Text>
      </View>
    </View>
  );
}

/** "Check your kit" input: the asked words, one field each. */
function WordFields({ positions, values, onChange }: { positions: number[]; values: Record<number, string>; onChange: (position: number, value: string) => void }) {
  return (
    <View className="gap-3">
      {positions.map((position) => (
        <View key={position} className="gap-1.5">
          <FieldLabel nativeID={`kit-word-${position}`}>{`Word ${position}`}</FieldLabel>
          <Input
            aria-labelledby={`kit-word-${position}`}
            accessibilityLabel={`Word ${position}`}
            value={values[position] ?? ''}
            onChangeText={(text) => onChange(position, text)}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
          />
        </View>
      ))}
    </View>
  );
}

/** The kit's page for the print dialog, and the words for someone without a printer. */
function PrintStage({ kit, hardwareBrand, onContinue, onCancel }: { kit: RecoveryKit; hardwareBrand: string; onContinue: () => void; onCancel?: () => void }) {
  const [showWords, setShowWords] = useState(false);
  const print = useAction();
  const seed = kit.kind === 'seed';
  return (
    <Screen
      title={seed ? 'Print your Recovery Kit' : 'Print your wallet map'}
      androidTitle={seed ? 'Print your kit' : 'Print your map'}
      backLabel="Back"
      onBack={onCancel}
      footer={
        <>
          <ActionNotice message={print.message} error={print.error} />
          <AppButton title="I've saved it" onPress={onContinue} />
        </>
      }>
      {seed ? <KeepApartNotice hardwareBrand={hardwareBrand} /> : null}
      <Body>
        {seed
          ? 'One sheet with a QR code and the words behind it. If you lose your phone or your hardware wallet, this sheet and the one you still have move your money to a new wallet.'
          : `Your ${kit.device ?? 'second hardware wallet'} is your Recovery Key. The sheet is a map of your wallet with no secret on it: keep it with that device, or anywhere you will find it. Without it, recovering means rebuilding the wallet by hand.`}
      </Body>
      <Panel>
        <InfoRow label="Wallet" value={kit.fingerprint} mono />
        <InfoRow label="Network" value={networkLabel(kit.network)} />
        <InfoRow label="Made" value={kit.date} />
      </Panel>
      <View className="gap-3">
        <AppButton title="Print or save as PDF" icon={FileText} busy={print.busy} onPress={() => void print.run(printKit(kit.html))} />
        {seed ? <AppButton title={showWords ? 'Hide the words' : 'No printer? Show the words'} variant="outline" onPress={() => setShowWords((v) => !v)} /> : null}
      </View>
      <Footnote>
        {seed
          ? 'The print sheet also saves a PDF or sends one with AirDrop. Printers, print queues and anywhere you send a PDF can keep a copy of a key: print on a printer you trust, and delete any PDF afterwards. Trikey does not keep the sheet.'
          : 'The print sheet also saves a PDF. This one holds no secret, so a copy is harmless.'}
      </Footnote>
      {seed && showWords ? (
        <Card className="gap-3 p-4">
          <Text className="text-sm font-medium leading-5">Write all {kit.recoveryWords.length + kit.mapWords.length} words down, in order, by hand</Text>
          <Text className="font-mono text-[13px] leading-5" selectable testID="kit-words">
            {[...kit.recoveryWords, ...kit.mapWords].map((word, i) => `${i + 1} ${word}`).join('   ')}
          </Text>
          <Footnote>The first 12 are your Recovery Key. The rest map your wallet. Anyone who sees them can take your money: not in a photo, not on a screen share.</Footnote>
        </Card>
      ) : null}
    </Screen>
  );
}

/** Proof that the kit is saved: the asked words, or a scan of its QR code. */
function CheckStage({
  kit,
  busy,
  message,
  error,
  confirmLabel,
  onBack,
  onProof,
}: {
  kit: RecoveryKit;
  busy: boolean;
  message: string | null;
  error: Error | null;
  confirmLabel: string;
  onBack: () => void;
  onProof: (proof: KitProof) => void;
}) {
  const [values, setValues] = useState<Record<number, string>>({});
  const [scanning, setScanning] = useState(false);
  const [scanProblem, setScanProblem] = useState<string | null>(null);
  const seed = kit.kind === 'seed';
  const complete = kit.challenge.every((p) => (values[p] ?? '').trim().length > 0);

  return (
    <Screen
      title={seed ? 'Check your Recovery Kit' : 'Wallet map saved?'}
      androidTitle={seed ? 'Check your kit' : 'Map saved?'}
      backLabel="Back"
      onBack={onBack}
      footer={
        <>
          <ActionNotice message={message} error={error} />
          {seed ? (
            <AppButton title={busy ? 'Setting up your vault…' : confirmLabel} busy={busy} disabled={!complete || scanning} onPress={() => onProof({ words: values })} />
          ) : (
            <AppButton title={busy ? 'Setting up your vault…' : "I've saved the wallet map"} busy={busy} onPress={() => onProof({ mapSaved: true })} />
          )}
        </>
      }>
      {seed ? (
        <>
          <Body>{`Look at the sheet you printed and type words ${kit.challenge.join(', ')}. This shows the sheet is readable. Or scan its QR code.`}</Body>
          <WordFields positions={kit.challenge} values={values} onChange={(p, v) => setValues((cur) => ({ ...cur, [p]: v }))} />
          <AppButton title={scanning ? 'Close camera' : 'Scan the QR code instead'} icon={QrCode} variant="outline" disabled={busy} onPress={() => setScanning((v) => !v)} />
          {scanning ? (
            <View className="gap-2">
              <QrScanner
                size={240}
                paused={busy}
                onFrame={(data) => {
                  if (!data.startsWith('TRIKEYKIT1:')) {
                    setScanProblem("That QR code isn't a Trikey Recovery Kit.");
                    return;
                  }
                  setScanProblem(null);
                  setScanning(false);
                  onProof({ scanned: data });
                }}
              />
              {scanProblem ? <Text className="text-destructive text-[13px] leading-[18px]">{scanProblem}</Text> : null}
            </View>
          ) : null}
        </>
      ) : (
        <Body>
          Keep the printed wallet map with your {kit.device ?? 'second hardware wallet'}. Your vault is built from your hardware wallet, this phone and that device. Nothing on the map can move money.
        </Body>
      )}
    </Screen>
  );
}

/**
 * The two steps every new Recovery Kit goes through, wherever it is made (first set-up, a recovery into a new vault, a lost
 * kit): print it, then prove it is saved. `onProof` is where the wallet carries on; it should reject with the wallet's
 * error, which this shows under the button, so a typo can be fixed.
 */
export function NewKitFlow({
  kit,
  hardwareBrand,
  confirmLabel = 'Check and continue',
  onProof,
  onCancel,
}: {
  kit: RecoveryKit;
  hardwareBrand: string;
  confirmLabel?: string;
  onProof: (proof: KitProof) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [stage, setStage] = useState<'print' | 'check'>('print');
  const action = useAction();
  if (stage === 'print') return <PrintStage kit={kit} hardwareBrand={hardwareBrand} onContinue={() => setStage('check')} onCancel={onCancel} />;
  return (
    <CheckStage
      kit={kit}
      busy={action.busy}
      message={action.message}
      error={action.error}
      confirmLabel={confirmLabel}
      onBack={() => (action.busy ? undefined : setStage('print'))}
      onProof={(proof) => void action.run(onProof(proof))}
    />
  );
}

/** A line of small print under a button: where the kit can go wrong. */
export function KitFootnote({ className }: { className?: string }) {
  return <Footnote className={cn(pick('', 'text-xs leading-4'), className)}>Keep your Recovery Kit apart from your phone and from your hardware wallet's seed words.</Footnote>;
}
