import { secureRandomBytes } from '@trikey/core/random';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Body, FieldLabel, Notice } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { QrScanner } from '@/hardware/ui';
import { FEATURES, previewOnUntil, type Feature } from '@/lib/features';
import { getPlatform } from '@/platform';
import { finishUnlock, readChallenge, startChallenge, turnOffPreview } from '@/lib/preview-store';
import { showCode, type Challenge } from '@/lib/preview-unlock';

/**
 * Preview (docs/design/public-release.md, section 3): for the owner, the features in preview on this phone for 24
 * hours, once the challenge is signed with the publisher key. Reached by holding the version row in Settings > About.
 */
export default function PreviewScreen() {
  const kv = getPlatform().kv;
  const [until, setUntil] = useState<number | null>(previewOnUntil());
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [pasted, setPasted] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void readChallenge(kv).then(setChallenge);
  }, [kv]);

  const inPreview = (Object.values(FEATURES) as Feature[]).filter((f) => f.stage === 'preview').map((f) => f.title);

  const submit = async (raw: string) => {
    if (busy) return;
    setBusy(true);
    const result = await finishUnlock(kv, raw);
    setBusy(false);
    if (result.ok) {
      setUntil(result.until);
      setChallenge(null);
      setProblem(null);
    } else setProblem(result.reason);
  };

  if (until) {
    return (
      <Screen
        title="Preview"
        backLabel="Settings"
        footer={
          <AppButton
            title="Turn preview off"
            variant="outline"
            onPress={() => void turnOffPreview(kv).then(() => setUntil(null))}
          />
        }>
        <Notice tone="fill" title="Preview is on">
          {`Until ${new Date(until * 1000).toLocaleString()}. Features in preview show on this phone only, then turn off by themselves. A wallet that uses one keeps it.`}
        </Notice>
        <PreviewList titles={inPreview} />
      </Screen>
    );
  }

  return (
    <Screen
      title="Preview"
      backLabel="Settings"
      footer={
        <AppButton
          title={challenge ? 'New challenge' : 'Make a challenge'}
          variant={challenge ? 'outline' : 'primary'}
          onPress={() =>
            void startChallenge(kv, secureRandomBytes).then((c) => {
              setChallenge(c);
              setProblem(null);
            })
          }
        />
      }>
      <Body>For Trikey's publisher only: preview turns on features that are being tried before everyone gets them. It needs a signature from the publisher key.</Body>
      {challenge ? (
        <View className="gap-4">
          <View className="gap-1">
            <FieldLabel>This phone's challenge</FieldLabel>
            <Text selectable className="font-mono text-2xl tracking-wider">
              {showCode(challenge.code)}
            </Text>
            <Text className="text-muted-foreground text-sm">On your computer: node tools/release/unlock-preview.mjs {challenge.code}. Then scan the code it shows. It works for 15 minutes.</Text>
          </View>
          <QrScanner onFrame={(data) => void submit(data)} paused={busy} />
          <FieldLabel nativeID="preview-paste">Or paste the signed unlock</FieldLabel>
          <Input aria-labelledby="preview-paste" value={pasted} onChangeText={setPasted} autoCapitalize="none" autoCorrect={false} multiline />
          <AppButton title="Check it" variant="outline" disabled={!pasted.trim() || busy} onPress={() => void submit(pasted)} />
        </View>
      ) : null}
      {problem ? <Notice tone="warn-outline">{problem}</Notice> : null}
      <PreviewList titles={inPreview} />
    </Screen>
  );
}

function PreviewList({ titles }: { titles: string[] }) {
  return (
    <View className="gap-1">
      <FieldLabel>In preview in this version</FieldLabel>
      {titles.length ? titles.map((t) => <Text key={t} className="text-sm">{`· ${t}`}</Text>) : <Text className="text-sm">Nothing</Text>}
    </View>
  );
}
