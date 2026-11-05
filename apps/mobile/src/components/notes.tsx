import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { CloudUpload, Download, ShieldCheck } from '@/components/icons';
import { Body, Footnote, Notice, QuietLink, SectionLabel } from '@/components/panels';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { formatDateTime24, useWallet, useWalletService, type NotesCopyView } from '@/data';
import { pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';

/** What the guardian learns, in the words every screen uses. */
export const NOTES_PRIVACY = "Your guardian can't read your notes. It learns roughly how many you keep and when you change them.";

/**
 * "Bring back your notes": the copies on the guardian this phone could take in (after a recovery to a new phone, or a
 * restore from a backup older than the copy), one hardware wallet confirmation each. `compact`: the recovery's last
 * screen, which shows only the button and what came back.
 */
export function BringBackNotes({ compact }: { compact?: boolean }) {
  const wallet = useWalletService();
  const { hardware } = useWallet();
  const notes = wallet.notes;
  const [copies, setCopies] = useState<NotesCopyView[] | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const bring = useAction();
  const load = useCallback(() => {
    if (!notes) return;
    notes.copies().then(setCopies, () => setCopies([]));
  }, [notes]);
  useEffect(load, [load]);
  if (!notes) return null;
  const waiting = (copies ?? []).filter((c) => !c.broughtBack);
  if (!waiting.length && !done) return null;
  const copy = waiting[0];
  const run = async () => {
    if (!copy) return;
    const r = await bring.run(notes.bringBack(copy.walletId));
    if (r.ok) {
      setDone(r.value.text);
      load();
    }
  };
  return (
    <View className="gap-3">
      {compact ? null : <SectionLabel>Bring back your notes</SectionLabel>}
      {done ? (
        <Notice icon={Download} tone="fill" title="Your notes are back">
          {done}
        </Notice>
      ) : copy ? (
        <>
          <Notice icon={Download} tone="outline" title="Your guardian kept your notes">
            {copy.thisWallet ? 'A copy of this wallet’s labels' : 'A copy of the labels of the wallet you recovered from'} ({copy.size}, saved {formatDateTime24(copy.at)}). Your{' '}
            {hardware.brand} unlocks it once. Labels this phone already has are kept.
          </Notice>
          <AppButton
            title={bring.busy ? `Waiting for your ${hardware.brand}…` : 'Bring back your notes'}
            icon={Download}
            variant={compact ? 'outline' : pick('secondary', 'outline')}
            busy={bring.busy}
            onPress={() => void run()}
          />
        </>
      ) : null}
      <ActionNotice message={bring.message} error={bring.error} />
    </View>
  );
}

/**
 * Settings > Wallet details > "Keep your notes safe with the guardian": off by default. On asks the hardware wallet to
 * confirm the same text twice (a key it can make again on a new phone); then every label change is sent, encrypted.
 * Off deletes the copy on the guardian.
 */
export function NotesSection() {
  const wallet = useWalletService();
  const { hardware } = useWallet();
  const notes = wallet.notes;
  const toggle = useAction();
  const [asking, setAsking] = useState(false);
  const s = notes?.state();
  if (!notes || !s) return null;
  // An older guardian, or a wallet not set up yet: hidden. Other reasons are said, so the person knows why.
  if (!s.available && !s.on && (s.unavailable === 'guardian' || s.unavailable === 'not_paired')) return null;
  const turnOff = async () => {
    const r = await toggle.run(notes.disable());
    if (r.ok) setAsking(false);
  };
  return (
    <>
      <SectionLabel>Notes</SectionLabel>
      <View className="min-h-14 flex-row items-center justify-between gap-4">
        <View className="flex-1">
          <Text nativeID="notes-label" className="text-base leading-6">
            Keep your notes safe with the guardian
          </Text>
          <Text className="text-muted-foreground text-sm leading-5">
            {s.on
              ? s.pending
                ? 'On. Your latest changes go out in a moment.'
                : `On.${s.uploadedAt ? ` Last copy ${formatDateTime24(s.uploadedAt)}.` : ''}`
              : 'Off. Your labels are only on this phone and in its backup.'}
          </Text>
        </View>
        <Switch
          checked={s.on}
          disabled={toggle.busy || asking || (!s.available && !s.on)}
          onCheckedChange={(next) => {
            if (next) void toggle.run(notes.enable());
            else setAsking(true);
          }}
          aria-labelledby="notes-label"
          accessibilityLabel="Keep your notes safe with the guardian"
        />
      </View>
      <Body>
        An encrypted copy of your coin labels, frozen coins and payment notes stays on your guardian, so they come back after a recovery even if this
        phone and its backup are lost. Only your {hardware.brand} can unlock it: turning this on asks it to confirm twice.
      </Body>
      <Footnote>{NOTES_PRIVACY}</Footnote>
      {toggle.busy && !s.on ? (
        <Notice icon={ShieldCheck} tone="fill" title={`Confirm on your ${hardware.brand}, twice`}>
          The same text appears twice. Trikey checks that your {hardware.brand} gives the same answer both times, so it can unlock your notes again on any
          phone.
        </Notice>
      ) : null}
      {!s.available && s.unavailableText ? <Notice tone="outline">{s.unavailableText}</Notice> : null}
      {s.onForEarlierWallet ? (
        <Notice icon={CloudUpload} tone="warn-outline" title="Turn it on for your recovered wallet">
          Your notes were kept for the wallet you recovered from. Turn this on again so the guardian keeps this wallet&apos;s notes too.
        </Notice>
      ) : null}
      {s.error && s.on ? <Notice tone="warn-outline">{s.error}</Notice> : null}
      {asking ? (
        <View className="gap-3">
          <Notice tone="warn-outline" title="Delete the copy on your guardian?">
            Your notes stay on this phone and in its backup. If you lose both, a recovery brings your money back but not your notes.
          </Notice>
          <AppButton title="Turn off and delete the copy" variant="outline" busy={toggle.busy} onPress={() => void turnOff()} />
          <QuietLink title="Keep it on" onPress={() => setAsking(false)} />
        </View>
      ) : null}
      <ActionNotice message={toggle.message} error={toggle.error} />
      <BringBackNotes />
    </>
  );
}
