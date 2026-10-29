import { useState } from 'react';
import { View } from 'react-native';
import { ListGroup, SettingsRow } from '@/components/panels';
import { Text } from '@/components/ui/text';
import { runCryptoSelfTest, summarize, type SelfTestReport } from '@/platform/self-test';

/**
 * Developer row: runs the crypto self-test (polyfills, key derivation, NIP-44, gift wrap) on
 * this device and shows pass or fail, with the failing steps underneath.
 */
export function SelfTestRow() {
  const [state, setState] = useState<{ running: boolean; report?: SelfTestReport; crash?: string }>({ running: false });

  const run = async () => {
    if (state.running) return;
    setState({ running: true });
    try {
      setState({ running: false, report: await runCryptoSelfTest() });
    } catch (e) {
      setState({ running: false, crash: e instanceof Error ? e.message : String(e) });
    }
  };

  const value = state.running
    ? 'Running...'
    : state.report
      ? summarize(state.report)
      : state.crash
        ? 'Failed'
        : 'Run';
  const failures = state.report?.steps.filter((s) => !s.ok) ?? [];

  return (
    <>
      <ListGroup>
        <SettingsRow title="Crypto self-test" value={value} dot={state.report ? (state.report.ok ? 'good' : 'bad') : undefined} onPress={run} />
      </ListGroup>
      {failures.length > 0 || state.crash ? (
        <View className="gap-1 px-4">
          {failures.map((s) => (
            <Text key={s.name} className="text-destructive text-sm leading-5">
              {s.name}: {s.error}
            </Text>
          ))}
          {state.crash ? <Text className="text-destructive text-sm leading-5">{state.crash}</Text> : null}
        </View>
      ) : null}
    </>
  );
}
