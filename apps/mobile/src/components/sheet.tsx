import type { ReactNode } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { GUTTER, useScreenInsets } from '@/components/screen';
import { Text } from '@/components/ui/text';
import { pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/** A bottom sheet over the current screen: a title, its content, and a tap outside to close. */
export function Sheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const insets = useScreenInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View className="flex-1 justify-end bg-black/40">
        <Pressable accessibilityLabel="Close" className="flex-1" onPress={onClose} />
        <View
          accessibilityViewIsModal
          className={cn('bg-background border-border gap-3 border-t', pick('rounded-t-[20px]', 'rounded-t-[28px]'))}
          style={{ paddingHorizontal: GUTTER, paddingTop: 10, paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          <View className="bg-border h-[5px] w-9 self-center rounded-full" />
          <Text role="heading" aria-level={2} className={pick('text-[20px] font-semibold leading-[26px]', 'text-xl font-medium leading-7')}>
            {title}
          </Text>
          {children}
        </View>
      </View>
    </Modal>
  );
}
