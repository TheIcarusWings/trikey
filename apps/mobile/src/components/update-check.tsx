import Constants from 'expo-constants';
import { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check, Download, ExternalLink, Info, TriangleAlert } from '@/components/icons';
import { Notice, SettingsRow } from '@/components/panels';
import { Text } from '@/components/ui/text';
import { errorText } from '@/data/errors';
import { useHapticOnce } from '@/lib/haptics';
import { useAction } from '@/lib/use-action';
import {
  RELEASES_PAGE_URL,
  UpdateCheckError,
  checkForUpdate,
  formatVersion,
  isReleaseDownloadUrl,
  type UpdateCheck as UpdateCheckResult,
} from '@/lib/update-check';

/**
 * Android only: the APKs are on GitHub, and Android installs a newer one over the app. iOS updates come from the App
 * Store or TestFlight, and the web preview has nothing to install. (`Platform.OS`, not `IS_ANDROID`: the web preview
 * can draw the Android design, but it is still not a phone.)
 */
export const CAN_CHECK_FOR_UPDATES = Platform.OS === 'android';

/** Opens a GitHub page in the browser. Only this repository's releases, whatever the answer said. */
function open(url: string) {
  void Linking.openURL(url).catch(() => {});
}

/**
 * Settings > About > Check for updates: the row and, once tapped, what GitHub said. GitHub is asked only when the
 * person taps the row, never in the background or when Settings opens (see src/lib/update-check.ts). "Download" opens
 * the APK in the browser, which downloads it and hands it to Android's installer: the app downloads and installs
 * nothing itself, so it needs no install permission.
 */
export function UpdateCheck() {
  const action = useAction();
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const version = Constants.expoConfig?.version ?? '';

  const check = async () => {
    if (action.busy) return;
    setResult(null);
    const r = await action.run(checkForUpdate(version, (url, init) => fetch(url, init)));
    if (r.ok) setResult(r.value);
  };

  const failure = action.error ? (action.error instanceof UpdateCheckError ? action.error.message : errorText(action.error)) : null;
  useHapticOnce('error', !!failure, failure);

  return (
    <View>
      <SettingsRow
        title="Check for updates"
        subtitle={action.busy ? 'Asking GitHub…' : 'Asks GitHub for the newest Android build'}
        onPress={() => void check()}
        accessibilityHint="Asks GitHub whether a newer Trikey is out"
      />
      {result || failure ? (
        <View testID="update-check-result" accessibilityLiveRegion="polite" className="gap-3 pb-3">
          {failure ? (
            <>
              <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline">
                {failure}
              </Notice>
              <AppButton title="Open the releases page" icon={ExternalLink} variant="ghost" onPress={() => open(RELEASES_PAGE_URL)} />
            </>
          ) : result?.kind === 'up-to-date' ? (
            <Notice icon={Check} tone="fill">
              You have the latest version ({result.current}).
            </Notice>
          ) : result?.kind === 'none' ? (
            <>
              <Notice icon={Info} tone="fill">
                GitHub has no Android build of Trikey to offer right now. You have {result.current}.
              </Notice>
              <AppButton title="Open the releases page" icon={ExternalLink} variant="ghost" onPress={() => open(RELEASES_PAGE_URL)} />
            </>
          ) : result?.kind === 'available' ? (
            <UpdateAvailable result={result} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function UpdateAvailable({ result }: { result: Extract<UpdateCheckResult, { kind: 'available' }> }) {
  const { release, sha256, current } = result;
  const version = formatVersion(release.version);
  return (
    <>
      <Notice icon={Download} tone="fill" title={`Version ${version} is available`}>
        {release.name}. You have {current}.
      </Notice>
      <AppButton
        title="Download"
        icon={Download}
        accessibilityLabel={`Download Trikey ${version} in the browser`}
        onPress={() => {
          // Checked when GitHub's answer was read, and again here: only this repository's release files are opened.
          if (isReleaseDownloadUrl(release.apkUrl)) open(release.apkUrl);
        }}
      />
      <Text className="text-muted-foreground text-[13px] leading-[18px]">
        Android installs it over this app and keeps your wallet only if both are signed with the Trikey release key (0.1.7 and
        later). Back up first.
      </Text>
      {sha256 ? (
        <View className="gap-0.5" accessible accessibilityLabel={`SHA-256 of the download: ${sha256}`}>
          <Text className="text-muted-foreground text-[13px] leading-[18px]">SHA-256 of the download</Text>
          <Text selectable className="font-mono text-xs leading-[18px]">
            {sha256}
          </Text>
        </View>
      ) : null}
      <AppButton title="Open the release page" icon={ExternalLink} variant="ghost" onPress={() => open(release.pageUrl)} />
    </>
  );
}
