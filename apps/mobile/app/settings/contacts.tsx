import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ActionNotice } from '@/components/action-notice';
import { AppButton } from '@/components/app-button';
import { Lock, Plus, Smartphone } from '@/components/icons';
import { Body, Footnote, ListGroup, Notice, SectionLabel } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { CONTACT_LOCK, canOfferContactLock, shorten, useWallet, useWalletService, type Contact } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { useAction } from '@/lib/use-action';
import { cn } from '@/lib/utils';

/**
 * "Contacts can lock the guardian": opt-in, shown only when the guardian supports it. On from this phone alone; off
 * needs the hardware wallet, after saying what that gives up.
 */
function ContactLockSection() {
  const wallet = useWalletService();
  const state = useWallet();
  const { hardware } = state;
  const [asking, setAsking] = useState(false);
  const toggle = useAction();
  if (!canOfferContactLock(state)) return null;
  const on = !!state.contactLock?.on;
  const turnOff = async () => {
    const r = await toggle.run(wallet.setContactLock(false));
    if (r.ok) setAsking(false);
  };
  return (
    <>
      <SectionLabel>Locking</SectionLabel>
      <View className="min-h-14 flex-row items-center justify-between gap-4">
        <View className="flex-1">
          <Text nativeID="contact-lock-label" className="text-base leading-6">
            {CONTACT_LOCK.title}
          </Text>
          <Text className="text-muted-foreground text-sm leading-5">{CONTACT_LOCK.short}</Text>
        </View>
        <Switch
          checked={on}
          disabled={toggle.busy || asking}
          onCheckedChange={(next) => {
            if (next) void toggle.run(wallet.setContactLock(true));
            else setAsking(true);
          }}
          aria-labelledby="contact-lock-label"
          accessibilityLabel={CONTACT_LOCK.title}
        />
      </View>
      {asking ? (
        <View className="gap-3">
          <Notice icon={Lock} tone="warn-outline" title="Stop contacts locking your guardian?">
            {`They won't be able to stop your guardian any more, even if they see something you didn't do. They still hear about recoveries and can cancel one. ${CONTACT_LOCK.offNeeds(hardware.brand)}`}
          </Notice>
          <View className="flex-row gap-3">
            <AppButton title="Keep" variant="outline" size="compact" className="flex-1 self-auto" disabled={toggle.busy} onPress={() => setAsking(false)} />
            <AppButton
              title={toggle.busy ? `Waiting for your ${hardware.brand}…` : `Turn off with ${hardware.brand}`}
              variant="destructive"
              size="compact"
              className="flex-1 self-auto"
              busy={toggle.busy}
              onPress={() => void turnOff()}
            />
          </View>
        </View>
      ) : null}
      <ActionNotice message={toggle.message} error={toggle.error} />
      <Footnote>{CONTACT_LOCK.allows}</Footnote>
      <Footnote>{CONTACT_LOCK.cannot}</Footnote>
      <Footnote>{`${CONTACT_LOCK.worst}${on ? '' : ' Turning it on works from this phone alone.'}`}</Footnote>
    </>
  );
}

function Avatar({ children }: { children: React.ReactNode }) {
  return <View className="bg-secondary size-10 shrink-0 items-center justify-center rounded-full">{children}</View>;
}

export default function AlertContacts() {
  const router = useRouter();
  const wallet = useWalletService();
  const { contacts, hardware } = useWallet();
  const [removing, setRemoving] = useState<Contact | null>(null);
  const { busy, run, message, error } = useAction();

  const remove = async (contact: Contact) => {
    const r = await run(wallet.removeContact(contact.id));
    if (r.ok) setRemoving(null);
  };

  return (
    <Screen
      title="Alert contacts"
      backLabel="Settings"
      footer={
        <>
          <ActionNotice message={message} error={error} />
          <AppButton title="Add contact" icon={Plus} variant="outline" onPress={() => router.push('/settings/add-contact')} />
          <Footnote className="text-center">Adding or removing a contact needs your {hardware.brand}.</Footnote>
        </>
      }>
      <Body>People who hear about any recovery attempt and can cancel it. They can't move your money.</Body>
      <ListGroup>
        {contacts.map((contact) => (
          <View key={contact.id}>
            <View
              accessible
              accessibilityLabel={`${contact.name}, ${shorten(contact.npub)}`}
              className={cn('flex-row items-center gap-3', IS_IOS ? 'px-4 py-3' : 'min-h-16 gap-4 py-2')}>
              <Avatar>
                <Text className="text-[15px] font-semibold">{contact.name[0]?.toUpperCase()}</Text>
              </Avatar>
              <View className="flex-1">
                <Text className={pick('text-base leading-[22px]', 'text-base leading-6')}>{contact.name}</Text>
                <Text className="text-muted-foreground font-mono text-xs leading-[18px]">{shorten(contact.npub)}</Text>
              </View>
              {removing?.id === contact.id ? null : (
                <Pressable
                  role="button"
                  accessibilityLabel={`Remove ${contact.name}`}
                  hitSlop={8}
                  disabled={busy}
                  onPress={() => setRemoving(contact)}
                  className="active:opacity-60">
                  <Text className="text-destructive text-sm font-medium leading-5">Remove</Text>
                </Pressable>
              )}
            </View>
            {removing?.id === contact.id ? (
              <View className={cn('gap-3 pb-3', IS_IOS ? 'px-4' : 'px-0')}>
                <Text className="text-muted-foreground text-sm leading-5">
                  Remove {contact.name}? They won't hear about recoveries any more. This needs your {hardware.brand}.
                </Text>
                <View className="flex-row gap-3">
                  <AppButton title="Keep" variant="outline" size="compact" className="flex-1 self-auto" disabled={busy} onPress={() => setRemoving(null)} />
                  <AppButton
                    title={busy ? `Waiting for your ${hardware.brand}…` : `Remove with ${hardware.brand}`}
                    variant="destructive"
                    size="compact"
                    className="flex-1 self-auto"
                    busy={busy}
                    onPress={() => void remove(contact)}
                  />
                </View>
              </View>
            ) : null}
          </View>
        ))}
        <View className={cn('flex-row items-center gap-3', IS_IOS ? 'px-4 py-3' : 'min-h-16 gap-4 py-2')}>
          <Avatar>
            <Icon as={Smartphone} size={20} className="text-foreground" strokeWidth={1.8} />
          </Avatar>
          <View className="flex-1">
            <Text className={pick('text-base leading-[22px]', 'text-base leading-6')}>This phone</Text>
            <Text className="text-muted-foreground text-xs leading-[18px]">always included</Text>
          </View>
        </View>
      </ListGroup>
      <Footnote>Alerts arrive as nostr messages, so contacts see them in any nostr app, like Damus or Amethyst.</Footnote>
      <ContactLockSection />
    </Screen>
  );
}
