import { usePreventRemove, useRouter, type Href } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, ChevronLeft } from '@/components/icons';
import { NetworkStrip } from '@/components/network-strip';
import { FLOATING_TAB_BAR_SPACE } from '@/components/tab-bar';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { backDecision, type BackHold } from '@/lib/back';
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

/**
 * Holds the screen against going back (see `backDecision`): the Android back button and the iOS swipe do nothing, or
 * call `hold` when it is a function (with `leave` to go back after all). Native only: on the web it would also stop a
 * page reload.
 */
export function useHoldBack(hold: BackHold) {
  usePreventRemove(!IS_WEB && !!hold, ({ data, repeat }) => {
    const decision = backDecision(data.action.type, hold);
    if (decision === 'proceed') repeat();
    else if (decision === 'redirect' && typeof hold === 'function') hold(repeat);
  });
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
  /** A small chip beside the title: right of the large title on iOS, at the end of the top bar on Android (the network pill). */
  titleAccessory?: ReactNode;
  /** iOS: skip the large title because the screen draws its own heading. */
  hideIosTitle?: boolean;
  /** iOS: extra classes for the large title (a smaller size, for long titles). */
  iosTitleClass?: string;
  /** Hide the back control (first screen of a flow). Also holds the screen against going back, unless `holdBack` says otherwise. */
  noBack?: boolean;
  /**
   * The Android back button and the iOS swipe: `true` does nothing, a function is called instead (it gets `leave`),
   * `false` goes back as usual. Defaults to `noBack`.
   */
  holdBack?: BackHold;
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
  /** Pull to refresh: called when the person pulls the content down. */
  onRefresh?: () => Promise<unknown>;
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
  titleAccessory,
  hideIosTitle,
  iosTitleClass,
  noBack,
  holdBack = noBack ?? false,
  onBack,
  tab,
  untitled,
  androidTitleWeight = 'medium',
  gap = 16,
  bare,
  bareTop = 40,
  scrollable = true,
  contentClassName,
  onRefresh,
}: ScreenProps) {
  const [refreshing, setRefreshing] = useState(false);
  // Content taller than its space scrolls under the footer: a hairline above the footer marks where it continues.
  const [viewport, setViewport] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const overflowing = scrollable && viewport > 0 && contentHeight > viewport + 1;
  const refresh = useCallback(async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      /* the screen shows what it knows; a failed refresh is not an error page */
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh]);
  useHoldBack(holdBack);
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
          testID="screen-back"
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
          <View className="flex-row items-center justify-between gap-3">
            <Text
              role="heading"
              aria-level={1}
              className={cn('shrink text-[32px] font-semibold leading-[38px] tracking-[-0.64px]', iosTitleClass)}>
              {title}
            </Text>
            {titleAccessory}
          </View>
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
            testID="screen-back"
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
        {titleAccessory ? <View className={cn('ml-auto', stepLabel || titleInBar || (tab && barTitle) ? '' : 'flex-1 items-end')}>{titleAccessory}</View> : null}
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
      onLayout={(e) => setViewport(e.nativeEvent.layout.height)}
      onContentSizeChange={(_, h) => setContentHeight(h)}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} /> : undefined}
      contentContainerStyle={{ flexGrow: 1, paddingHorizontal: GUTTER, gap, paddingBottom: tab && IS_IOS ? FLOATING_TAB_BAR_SPACE : footer || tab ? 16 : insets.bottom }}>
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
      style={{ paddingTop: insets.top }}>
      <NetworkStrip />
      {bare ? <View style={{ height: bareTop }} /> : null}
      {header}
      {body}
      {footer ? (
        <View
          className={cn('gap-4', overflowing && 'border-border border-t pt-3')}
          style={{ paddingHorizontal: GUTTER, paddingBottom: insets.bottom }}>
          {footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
