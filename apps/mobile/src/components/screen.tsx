import { useRouter, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, ChevronLeft } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { IS_ANDROID, IS_IOS, IS_WEB, pick } from '@/lib/platform';
import { cn } from '@/lib/utils';

/** Horizontal gutter of screen content: 20 on iOS, 16 + 8 on Android. */
export const GUTTER = pick(20, 24);

/**
 * Space above and below content. The designs mock a status bar (iOS 54, Android 32)
 * and a home indicator; on a device the real safe-area insets stand in for them.
 */
export function useScreenInsets(): { top: number; bottom: number } {
  const insets = useSafeAreaInsets();
  if (IS_WEB) return { top: pick(54, 32), bottom: pick(40, 32) };
  return {
    top: insets.top,
    bottom: pick(insets.bottom + 6, Math.max(insets.bottom, 16) + 16),
  };
}

/** Goes back, or to Home when the screen was opened directly and there is nothing to go back to. */
export function useGoBack(fallback: Href = '/home') {
  const router = useRouter();
  return () => {
    if (router.canGoBack()) router.back();
    else router.replace(fallback);
  };
}

type ScreenProps = {
  children?: ReactNode;
  /** Pinned under the scrolling content: the screen's buttons. */
  footer?: ReactNode;
  /** The h1. */
  title?: string;
  /** Android shows this in the top bar instead of `title`. */
  androidTitle?: string;
  /** Android puts the title under the bar (28px) instead of in it. Wizards and big questions do. */
  androidTitleBelow?: boolean;
  /** "Step 1 of 4". iOS shows it above the title, Android in the bar. */
  step?: { n: number; total: number };
  /** iOS: the label next to the back chevron ("Settings", "Home", "Back"). */
  backLabel?: string;
  /** Rendered between the back control and the title (a status chip). */
  beforeTitle?: ReactNode;
  /** iOS: skip the large title because the screen draws its own heading. */
  hideIosTitle?: boolean;
  /** iOS: extra classes for the large title (a smaller size, for long titles). */
  iosTitleClass?: string;
  /** Hide the back control (first screen of a flow). */
  noBack?: boolean;
  onBack?: () => void;
  /** Tab roots: no back control, large title (iOS) or plain top bar (Android). */
  tab?: boolean;
  /** Tab root without a title on iOS (Home shows the balance straight away). */
  untitled?: boolean;
  androidTitleWeight?: 'normal' | 'medium';
  /** Vertical gap between children. */
  gap?: number;
  /** No back control or bar: the screen draws everything itself (status screens). */
  bare?: boolean;
  /** Space under the status bar for a bare screen. */
  bareTop?: number;
  scrollable?: boolean;
  contentClassName?: string;
};

export function Screen({
  children,
  footer,
  title,
  androidTitle,
  androidTitleBelow,
  step,
  backLabel = 'Back',
  beforeTitle,
  hideIosTitle,
  iosTitleClass,
  noBack,
  onBack,
  tab,
  untitled,
  androidTitleWeight = 'medium',
  gap = 16,
  bare,
  bareTop = 40,
  scrollable = true,
  contentClassName,
}: ScreenProps) {
  const goBack = useGoBack();
  const insets = useScreenInsets();
  const back = onBack ?? goBack;

  const stepLabel = step ? `Step ${step.n} of ${step.total}` : undefined;
  const titleInBar = IS_ANDROID && !!title && !step && !androidTitleBelow;
  const barTitle = androidTitle ?? title;

  const header = bare ? null : IS_IOS ? (
    <View
      style={{ paddingHorizontal: GUTTER, paddingTop: tab ? 10 : 0, paddingBottom: tab ? (untitled ? 0 : gap) : 16 }}
      className={tab ? undefined : 'gap-4'}>
      {tab ? null : noBack ? (
        <View style={{ height: 12 }} />
      ) : (
        <Pressable
          onPress={back}
          role="link"
          accessibilityLabel={backLabel === 'Back' ? 'Back' : `Back to ${backLabel}`}
          hitSlop={8}
          className="h-11 flex-row items-center self-start pr-3 active:opacity-60">
          <Icon as={ChevronLeft} size={24} className="text-foreground" strokeWidth={2} />
          <Text className="text-[17px] leading-[22px]">{backLabel}</Text>
        </Pressable>
      )}
      {beforeTitle}
      {title && !untitled && !hideIosTitle ? (
        <View className="gap-1.5">
          {stepLabel ? (
            <Text className="text-muted-foreground text-[13px] font-semibold leading-[18px]">
              {stepLabel.toUpperCase()}
            </Text>
          ) : null}
          <Text
            role="heading"
            aria-level={1}
            className={cn('text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', iosTitleClass)}>
            {title}
          </Text>
        </View>
      ) : null}
    </View>
  ) : (
    <View className={cn('gap-4', tab ? 'pb-2' : 'pb-4')}>
      <View className="h-16 flex-row items-center gap-1 px-4">
        {tab || noBack ? null : (
          <Pressable
            onPress={back}
            role="link"
            accessibilityLabel="Back"
            className="size-12 items-center justify-center rounded-full active:bg-accent">
            <Icon as={ArrowLeft} size={24} className="text-foreground" strokeWidth={2} />
          </Pressable>
        )}
        {stepLabel ? (
          <Text className="text-muted-foreground text-sm leading-5">{stepLabel}</Text>
        ) : titleInBar || (tab && barTitle) ? (
          <Text
            role="heading"
            aria-level={1}
            className={cn(
              'flex-1 text-[22px] leading-7',
              androidTitleWeight === 'medium' ? 'font-medium' : 'font-normal'
            )}>
            {barTitle}
          </Text>
        ) : null}
      </View>
      {beforeTitle ? <View style={{ paddingHorizontal: GUTTER }}>{beforeTitle}</View> : null}
      {title && !titleInBar && !tab ? (
        <Text
          role="heading"
          aria-level={1}
          style={{ paddingHorizontal: GUTTER }}
          className={cn('text-[28px] leading-9', step ? 'font-normal' : 'font-semibold tracking-[-0.56px]')}>
          {title}
        </Text>
      ) : null}
    </View>
  );

  const body = scrollable ? (
    <ScrollView
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ flexGrow: 1, paddingHorizontal: GUTTER, gap, paddingBottom: footer || tab ? 16 : insets.bottom }}>
      {children}
    </ScrollView>
  ) : (
    <View className={cn('flex-1', contentClassName)} style={{ paddingHorizontal: GUTTER, gap }}>
      {children}
    </View>
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="bg-background flex-1"
      style={{ paddingTop: insets.top + (bare ? bareTop : 0) }}>
      {header}
      {body}
      {footer ? (
        <View className="gap-4" style={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom }}>
          {footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
