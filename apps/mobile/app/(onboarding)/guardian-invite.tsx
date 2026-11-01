import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Check } from '@/components/icons';
import { MainnetWarning } from '@/components/network-picker';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useWallet, useWalletService } from '@/data';
import { inviteDisclosure, publicServer } from '@/data/hosted';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text role="heading" className="text-sm font-semibold leading-5">
        {title}
      </Text>
      <View className={pick('gap-1.5', 'gap-2')}>{children}</View>
    </View>
  );
}

/**
 * A host's invite to keep key 3 of this wallet on their guardian (docs/design/family-hosting.md, section 9): who invites,
 * what they can and cannot do, what the guest trusts them with (a dishonest host could help a thief skip the wait), the
 * public chain server and the required phone key backup, and the "I understand" checkbox without which nothing is
 * accepted. On mainnet the same pre-alpha warning and consent as guardian mode.
 */
export default function GuardianInvite() {
  const router = useRouter();
  const wallet = useWalletService();
  const { invite, hardware, network, mainnetRiskAccepted, backing } = useWallet();
  // The demo has no invite to scan: its placeholder link is filled in.
  const [link, setLink] = useState(backing === 'demo' ? 'demo-invite' : '');
  const [problem, setProblem] = useState<string | null>(null);

  if (!invite) {
    // Opened from "I have an invite from someone" without a scanned code: paste the link.
    return (
      <Screen
        title="Open an invite"
        backLabel="Back"
        footer={
          <>
            <ActionNotice message={problem} />
            <AppButton
              title="Read the invite"
              disabled={!link.trim() || !wallet.readInvite}
              onPress={() => {
                try {
                  wallet.readInvite?.(link.trim());
                  setProblem(null);
                } catch (e) {
                  setProblem(e instanceof Error ? e.message : 'This invite cannot be used.');
                }
              }}
            />
          </>
        }>
        <Text className="text-base leading-6">Paste the invite link they sent you, or scan its code from the previous screen.</Text>
        <Input value={link} onChangeText={setLink} placeholder="trikey://invite?…" autoCapitalize="none" autoCorrect={false} accessibilityLabel="Invite link" />
      </Screen>
    );
  }

  const host = invite.hostLabel ?? 'Your host';
  const d = inviteDisclosure({ host, device: hardware.brand, server: publicServer(invite.network), ownServer: false });
  const needsMainnet = invite.mainnet && !mainnetRiskAccepted;
  return (
    <Screen
      title={d.title}
      androidTitle="Guardian invite"
      iosTitleClass="text-[28px] leading-[34px] tracking-[-0.56px]"
      footer={
        <>
          <AppButton title="Accept and continue" disabled={!invite.acknowledged || needsMainnet} onPress={() => router.push('/set-limit')} />
          <AppButton title="Decline" variant="outline" onPress={() => router.back()} />
        </>
      }>
      <Card className="flex-row items-center gap-3 px-4 py-3">
        <View className="bg-secondary size-10 shrink-0 items-center justify-center rounded-full">
          <Text className="text-base font-semibold">{host[0]}</Text>
        </View>
        <View className="min-w-0 flex-1">
          <Text className={cn('font-medium', pick('text-base leading-[22px]', 'text-base leading-6'))}>{host}</Text>
          <Text className="text-muted-foreground font-mono text-[13px] leading-[18px]" numberOfLines={1}>
            {invite.npub}
          </Text>
        </View>
      </Card>
      <Section title={d.cannotTitle}>
        {d.cannot.map((line) => (
          <View key={line} className={cn('flex-row', pick('gap-2.5', 'gap-3'))}>
            <Icon as={Check} size={18} className="text-good mt-px" strokeWidth={2.2} />
            <Text className="flex-1 text-sm leading-5">{line}</Text>
          </View>
        ))}
      </Section>
      <Section title={d.trustingTitle}>
        {d.trusting.map((line) => (
          <View key={line.text} className={cn('flex-row', pick('gap-2.5', 'gap-3'))}>
            <Text className="text-muted-foreground w-[18px] text-center text-sm leading-5">{'·'}</Text>
            <Text className={cn('flex-1 text-sm leading-5', line.strong ? 'font-semibold' : '')}>{line.text}</Text>
          </View>
        ))}
      </Section>
      <Section title={d.changesTitle}>
        {d.changes.map((line) => (
          <View key={line} className={cn('flex-row', pick('gap-2.5', 'gap-3'))}>
            <Text className="text-muted-foreground w-[18px] text-center text-sm leading-5">{'·'}</Text>
            <Text className="flex-1 text-sm leading-5">{line}</Text>
          </View>
        ))}
      </Section>
      {invite.mainnet || network === 'bitcoin' ? <MainnetWarning /> : null}
      <Pressable
        role="checkbox"
        aria-checked={invite.acknowledged}
        accessibilityLabel={d.checkbox}
        onPress={() => wallet.acknowledgeInvite?.(!invite.acknowledged)}
        className="flex-row items-center gap-3 py-2 active:opacity-70">
        <View className={cn('size-6 items-center justify-center rounded-md border', invite.acknowledged ? 'bg-primary border-primary' : 'border-chevron')}>
          {invite.acknowledged ? <Icon as={Check} size={16} className="text-primary-foreground" strokeWidth={3} /> : null}
        </View>
        <Text className={cn('flex-1', pick('text-[17px] leading-[22px]', 'text-base leading-6'))}>{d.checkbox}</Text>
      </Pressable>
      <Text className="text-muted-foreground text-[13px] leading-[18px]">{d.contactHint}</Text>
      <Text className="text-muted-foreground text-[13px] leading-[18px]">{d.footer}</Text>
    </Screen>
  );
}
