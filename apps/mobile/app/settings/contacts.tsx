import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Plus, Smartphone } from '@/components/icons';
import { Body, Footnote, ListGroup } from '@/components/panels';
import { Screen } from '@/components/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { shorten, useWallet } from '@/data';
import { IS_IOS, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

function Avatar({ children }: { children: React.ReactNode }) {
  return <View className="bg-secondary size-10 shrink-0 items-center justify-center rounded-full">{children}</View>;
}

export default function AlertContacts() {
  const router = useRouter();
  const { contacts, hardware } = useWallet();
  return (
    <Screen
      title="Alert contacts"
      backLabel="Settings"
      footer={
        <>
          <AppButton title="Add contact" icon={Plus} variant="outline" onPress={() => router.push('/settings/add-contact')} />
          <Footnote className="text-center">Adding or removing a contact needs your {hardware.brand}.</Footnote>
        </>
      }>
      <Body>People who hear about any recovery attempt and can cancel it. They can't move your money.</Body>
      <ListGroup>
        {contacts.map((contact) => (
          <View
            key={contact.id}
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
    </Screen>
  );
}
