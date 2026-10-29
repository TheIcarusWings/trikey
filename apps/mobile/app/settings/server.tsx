import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check, Server, TriangleAlert } from '@/components/icons';
import { Body, FieldLabel, Footnote, Notice, Panel, InfoRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Input } from '@/components/ui/input';
import { SERVER_PRIVACY_NOTE, networkLabel, serverHost, useWallet, useWalletService, type ServerCheck } from '@/data';
import { useAction } from '@/lib/use-action';

/**
 * Where Recovery Key mode reads the chain. Without a home server the phone asks an Esplora server, and that server learns
 * every address the wallet uses. The default is a public one; "Use my own server" takes the address of the person's own
 * (Umbrel and Start9 both run one) and tries it with a real request before using it.
 */
export default function ChainServerSettings() {
  const router = useRouter();
  const wallet = useWalletService();
  const { recoveryKey, network, backing } = useWallet();
  const { server } = recoveryKey;
  const [url, setUrl] = useState(server.isDefault ? '' : server.url);
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [checkedUrl, setCheckedUrl] = useState('');
  const testing = useAction();
  const saving = useAction();
  const trimmed = url.trim();
  const passed = check?.ok === true && checkedUrl === trimmed;

  const test = async () => {
    setCheck(null);
    const r = await testing.run(wallet.rk!.testServer(trimmed));
    if (r.ok) {
      setCheck(r.value);
      setCheckedUrl(trimmed);
    }
  };

  const save = async (value: string | null) => {
    const r = await saving.run(wallet.rk!.setServer(value));
    if (r.ok) router.back();
  };

  return (
    <Screen
      title="Chain server"
      backLabel="Settings"
      footer={
        <>
          <ActionNotice message={saving.message} error={saving.error} />
          <AppButton title="Use this server" busy={saving.busy} disabled={!passed} onPress={() => void save(trimmed)} />
        </>
      }>
      <Body>Trikey reads your balances and sends your transactions through a chain server, because there is no home server in this mode.</Body>
      <Notice icon={TriangleAlert} iconClass="text-warn" tone="warn" title="What a public server sees">
        {SERVER_PRIVACY_NOTE} Pointing Trikey at your own server (Umbrel and Start9 both run one) keeps all of that at home.
      </Notice>
      <Panel>
        <InfoRow label="Using now" value={serverHost(server.url)} />
        <InfoRow label="Kind" value={server.isDefault ? (backing === 'simulator' ? "The simulator's chain" : `Public, ${networkLabel(network ?? 'testnet')}`) : 'Yours'} />
      </Panel>

      <View className="gap-1.5">
        <FieldLabel nativeID="server-url-label">Use my own server</FieldLabel>
        <Input
          aria-labelledby="server-url-label"
          accessibilityLabel="Chain server address"
          placeholder="https://mempool.example.com/api"
          value={url}
          onChangeText={(text) => {
            setUrl(text);
            setCheck(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          keyboardType="url"
          className="font-mono text-[15px]"
        />
        <Footnote>The address of its Esplora API, the one that ends in /api (Umbrel's Mempool app: http://umbrel.local:3006/api). Plain http:// is for servers on your own network only.</Footnote>
      </View>
      <AppButton title={testing.busy ? 'Trying it…' : 'Try it'} icon={Server} variant="outline" busy={testing.busy} disabled={!trimmed} onPress={() => void test()} />
      <ActionNotice message={testing.message} error={testing.error} />
      {check ? (
        check.ok ? (
          <Notice icon={Check} iconClass="text-good" tone="fill" title="It works">
            {check.message}
          </Notice>
        ) : (
          <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline" title="Not this one">
            {check.message}
          </Notice>
        )
      ) : null}
      {server.isDefault ? null : <AppButton title="Go back to the public server" variant="ghost" busy={saving.busy} onPress={() => void save(null)} />}
    </Screen>
  );
}
