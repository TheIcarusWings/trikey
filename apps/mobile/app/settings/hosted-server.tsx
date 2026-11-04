import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Body, FieldLabel, Footnote } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Input } from '@/components/ui/input';
import { serverHost, useWallet, useWalletService } from '@/data';
import { HOSTED_SERVER_NOTE } from '@/data/hosted';
import { useAction } from '@/lib/use-action';

/**
 * Where a hosted wallet reads the chain (docs/design/family-hosting.md, section 6). Never from the host's guardian (it
 * would learn every address): the person's own Esplora if they have one, else a public one, which sees the addresses
 * and the phone's IP address but cannot move the money. Before a recovery sweep a second public server is asked too.
 */
export default function HostedServerSettings() {
  const router = useRouter();
  const wallet = useWalletService();
  const { hosted } = useWallet();
  const [url, setUrl] = useState(hosted?.chainServer ?? '');
  const { busy, run, message, error } = useAction();
  if (!hosted) return <Screen title="Chain server" backLabel="Back"><Body>Only a wallet hosted on someone else's guardian has this setting.</Body></Screen>;
  const save = async (value: string | null) => {
    const r = await run(wallet.setHostedChainServer!(value));
    if (r.ok) router.back();
  };
  return (
    <Screen
      title="Chain server"
      backLabel="Back"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton title="Use my own server" busy={busy} disabled={!url.trim()} onPress={() => void save(url)} />
          {hosted.chainServer ? <AppButton title="Use the public server" variant="outline" busy={busy} onPress={() => void save(null)} /> : null}
        </>
      }>
      <Body>
        Your host's box never tells this phone your balance: it would have to learn all your addresses. This phone asks{' '}
        {serverHost(hosted.chainServer ?? hosted.publicServer)} instead{hosted.chainServer ? '' : ', a public server'}.
      </Body>
      <Footnote>{HOSTED_SERVER_NOTE}</Footnote>
      <FieldLabel nativeID="hosted-server">Your own Esplora server</FieldLabel>
      <Input aria-labelledby="hosted-server" value={url} onChangeText={setUrl} placeholder="https://mempool.example/api" autoCapitalize="none" autoCorrect={false} accessibilityLabel="Your own Esplora server" />
    </Screen>
  );
}
