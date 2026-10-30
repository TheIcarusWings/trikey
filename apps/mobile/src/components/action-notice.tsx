import type { ReactNode } from 'react';
import { Linking, Platform, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { hardwareFix, type HardwareFix } from '@/components/hardware-fix';
import { Clock, Settings, TriangleAlert } from '@/components/icons';
import { Notice } from '@/components/panels';
import { WalletServiceError } from '@/data/errors';

/**
 * What went wrong, in the app's own voice, under the button that was pressed. A feature that is not built yet shows
 * as a quiet "later" note instead of a red error; a hardware wallet that can't be reached because of a setting on this
 * phone (Bluetooth off, permission refused) gets a button to that setting. Renders nothing without a message.
 */
export function ActionNotice({ message, error, children }: { message: string | null; error?: Error | null; children?: ReactNode }) {
  if (!message) return null;
  const later = error instanceof WalletServiceError && error.kind === 'not_available';
  return (
    <View accessibilityLiveRegion="assertive" className="gap-3">
      <Notice icon={later ? Clock : TriangleAlert} iconClass={later ? 'text-foreground' : 'text-destructive'} tone={later ? 'fill' : 'warn-outline'} title={later ? 'Coming later' : undefined}>
        {message}
      </Notice>
      <FixButton fix={hardwareFix(error)} />
      {children}
    </View>
  );
}

/** The same quiet note for a screen that is not usable in this mode at all (Recovery Key mode outside the demo). */
export function ComingLater({ children }: { children: ReactNode }) {
  return (
    <Notice icon={Clock} tone="fill" title="Coming later">
      {children}
    </Notice>
  );
}

/**
 * The way to the setting that fixes it. iOS doesn't let an app open the Bluetooth switch, so there "Bluetooth is turned
 * off" stays a sentence; a refused permission is in the app's own settings on both.
 */
function FixButton({ fix }: { fix: HardwareFix | null }) {
  if (fix === 'permission') {
    return <AppButton title="Open settings" icon={Settings} variant="outline" onPress={() => void Linking.openSettings()} />;
  }
  if (fix === 'bluetooth-off' && Platform.OS === 'android') {
    return (
      <AppButton
        title="Turn on Bluetooth"
        icon={Settings}
        variant="outline"
        onPress={() => void Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS').catch(() => Linking.openSettings())}
      />
    );
  }
  return null;
}
