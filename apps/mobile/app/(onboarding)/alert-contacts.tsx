import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check } from '@/components/icons';
import { Body, FieldLabel, Footnote, ListGroup, QuietLink, SettingsRow } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { errorText, looksLikeNpub, useWallet, useWalletService } from '@/data';
import { pick } from '@/lib/platform';

type Contact = { name: string; npub: string };

/**
 * Step 2 of guardian onboarding: who hears about a recovery. The guardian on mainnet will not pair without at least one;
 * the person's own nostr app on another device counts. The list goes to the wallet now and to the guardian with the
 * first rules (Protection), so adding them here needs no hardware approval.
 */
export default function AlertContacts() {
  const router = useRouter();
  const wallet = useWalletService();
  const { network } = useWallet();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [adding, setAdding] = useState<'self' | 'someone' | null>(null);
  const [name, setName] = useState('');
  const [npub, setNpub] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // Test networks may skip (the guardian then warns `no_alert_contacts`); mainnet may not.
  const canSkip = network !== 'bitcoin';

  const startAdding = (kind: 'self' | 'someone') => {
    setAdding(kind);
    setName(kind === 'self' ? 'My nostr app' : '');
    setNpub('');
    setProblem(null);
  };
  const add = () => {
    const next = { name: name.trim() || 'Alert contact', npub: npub.trim() };
    if (!looksLikeNpub(next.npub)) {
      setProblem("That doesn't look like a nostr public key (npub…).");
      return;
    }
    setContacts((list) => (list.some((c) => c.npub === next.npub) ? list : [...list, next]));
    setAdding(null);
  };
  const go = (list: Contact[]) => {
    try {
      wallet.setOnboardingContacts(list);
    } catch (e) {
      setProblem(errorText(e));
      return;
    }
    router.push('/scan-guardian');
  };

  return (
    <Screen
      title="Who should hear about a recovery?"
      step={{ n: 2, total: 5 }}
      backLabel="Back"
      footer={
        <>
          <AppButton title="Continue" size="hero" disabled={contacts.length === 0 || adding !== null} onPress={() => go(contacts)} />
          {canSkip ? <QuietLink title="Skip for now (test networks only)" onPress={() => go([])} /> : null}
        </>
      }>
      <Body>If anyone tries to recover your wallet, these people get an alert every day of the waiting period, and any of them can stop it.</Body>
      {contacts.length > 0 ? (
        <ListGroup>
          {contacts.map((c) => (
            <View key={c.npub} className="min-h-14 flex-row items-center gap-3 px-4 py-2" accessible accessibilityLabel={`${c.name}, ${c.npub}`}>
              <View className="flex-1">
                <Text className="text-base leading-[21px]">{c.name}</Text>
                <Text className="text-muted-foreground font-mono text-[13px] leading-[18px]">
                  {c.npub.slice(0, 12)}…{c.npub.slice(-4)}
                </Text>
              </View>
              <Icon as={Check} size={18} strokeWidth={2.4} className="text-good" />
            </View>
          ))}
        </ListGroup>
      ) : null}
      {adding ? (
        <View className="gap-3">
          <View className="gap-1.5">
            <FieldLabel nativeID="contact-name">Name</FieldLabel>
            <Input aria-labelledby="contact-name" value={name} onChangeText={setName} placeholder={adding === 'self' ? 'My nostr app' : 'Their name'} />
          </View>
          <View className="gap-1.5">
            <FieldLabel nativeID="contact-npub">Their nostr public key</FieldLabel>
            <Input
              aria-labelledby="contact-npub"
              value={npub}
              onChangeText={(t) => {
                setNpub(t);
                setProblem(null);
              }}
              placeholder="npub1…"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              className="font-mono text-[13px]"
            />
          </View>
          {problem ? <Text className="text-destructive text-[13px] leading-[18px]">{problem}</Text> : null}
          <View className="flex-row gap-3">
            <AppButton title="Cancel" variant="outline" className="flex-1 self-auto" onPress={() => setAdding(null)} />
            <AppButton title="Add" className="flex-1 self-auto" onPress={add} />
          </View>
        </View>
      ) : (
        <ListGroup>
          {contacts.length === 0 ? (
            <SettingsRow title="My own nostr app" subtitle="On another device, like a laptop" onPress={() => startAdding('self')} />
          ) : null}
          <SettingsRow title="Add someone you trust" subtitle="They need a nostr app too" onPress={() => startAdding('someone')} />
        </ListGroup>
      )}
      {problem && !adding ? <Text className="text-destructive text-[13px] leading-[18px]">{problem}</Text> : null}
      <Footnote className={pick('', 'text-xs leading-4')}>Alerts are nostr messages. You can change this list later in Security, with your hardware wallet.</Footnote>
    </Screen>
  );
}
