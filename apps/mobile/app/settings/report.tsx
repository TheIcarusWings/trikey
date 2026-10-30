import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { AppButton } from '@/components/app-button';
import { diagnostics, issueUrl } from '@/components/diagnostics';
import { Check, Copy, Info } from '@/components/icons';
import { Body, Notice, Panel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { useWallet } from '@/data';

/**
 * Settings > Report a problem: a new GitHub issue with the app's diagnostics filled in. The issue is public, so the
 * screen shows every line that goes with it before anything leaves the phone.
 */
export default function ReportScreen() {
  const state = useWallet();
  const lines = diagnostics(state, { version: Constants.expoConfig?.version ?? '?', os: Platform.OS, osVersion: String(Platform.Version) });
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    await Clipboard.setStringAsync(lines.join('\n'));
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Screen
      title="Report a problem"
      backLabel="Settings"
      footer={
        <>
          <AppButton title="Open GitHub" onPress={() => void Linking.openURL(issueUrl(lines))} />
          <AppButton title={copied ? 'Copied' : 'Copy diagnostics'} icon={copied ? Check : Copy} variant="outline" onPress={() => void copy()} />
        </>
      }>
      <Body>This opens a new issue on GitHub in your browser, with these lines added. Say what happened there; you need a GitHub account to post.</Body>
      <Panel className="px-4 py-3.5">
        <Text selectable accessibilityLabel={`Diagnostics: ${lines.join('. ')}`} className="font-mono text-[13px] leading-5">
          {lines.join('\n')}
        </Text>
      </Panel>
      <Notice icon={Info} tone="fill" title="Issues are public">
        These lines say what kind of wallet this is, not which one: no addresses, amounts or keys, and nothing that reaches your guardian. Don't
        add those to the issue either.
      </Notice>
    </Screen>
  );
}
