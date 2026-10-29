import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Clock, TriangleAlert } from '@/components/icons';
import { Notice } from '@/components/panels';
import { WalletServiceError } from '@/data/errors';

/**
 * What went wrong, in the app's own voice, under the button that was pressed. A feature that is not built yet shows
 * as a quiet "later" note instead of a red error. Renders nothing without a message.
 */
export function ActionNotice({ message, error, children }: { message: string | null; error?: Error | null; children?: ReactNode }) {
  if (!message) return null;
  const later = error instanceof WalletServiceError && error.kind === 'not_available';
  return (
    <View accessibilityLiveRegion="assertive" className="gap-3">
      <Notice icon={later ? Clock : TriangleAlert} iconClass={later ? 'text-foreground' : 'text-destructive'} tone={later ? 'fill' : 'warn-outline'} title={later ? 'Coming later' : undefined}>
        {message}
      </Notice>
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
