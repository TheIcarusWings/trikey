import Constants from 'expo-constants';
import { useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { AppButton } from '@/components/app-button';
import { Check, Download, ExternalLink, Info, ShieldCheck, TriangleAlert } from '@/components/icons';
import { Notice, SettingsRow } from '@/components/panels';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { errorText } from '@/data/errors';
import { ANDROID_VARIANT } from '@/lib/android-variant';
import { useHapticOnce } from '@/lib/haptics';
import { RELEASE_CERT_SHA256, formatFingerprint } from '@/lib/release-cert';
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
 * nothing itself, so it needs no install permission. The sheet shows the release certificate built into this app as the
 * signer to expect, never a checksum from the release itself (see src/lib/update-check.ts, and DESIGN.md, "Release
 * supply chain", for checking the APK's certificate in the app before handing it over, which is not built yet).
 */
export function UpdateCheck() {
  const action = useAction();
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const version = Constants.expoConfig?.version ?? '';

  const check = async () => {
    if (action.busy) return;
    setResult(null);
    // The APK of the build that is installed: the standard one, or the one without Google code.
    // The running app's id: an APK with another one installs as a new app (update-check.ts, `newApp`).
    const installedAppId = Constants.expoConfig?.android?.package;
    const r = await action.run(
      checkForUpdate(version, (url, init) => fetch(url, init), { variant: ANDROID_VARIANT, ...(installedAppId ? { installedAppId } : {}) })
    );
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

/** The release certificate's SHA-256, as AppVerifier and Android's tools print it. */
const FINGERPRINT = formatFingerprint(RELEASE_CERT_SHA256);

function UpdateAvailable({ result }: { result: Extract<UpdateCheckResult, { kind: 'available' }> }) {
  const { release, current, appId, newApp } = result;
  const version = formatVersion(release.version);
  return (
    <>
      <Notice icon={Download} tone="fill" title={`Version ${version} is available`}>
        {release.name}. You have {current}.
      </Notice>
      {newApp ? (
        <Notice icon={TriangleAlert} iconClass="text-destructive" tone="warn-outline" title="This installs as a new app">
          {`This APK is ${appId}, a different app from this one, so Android installs it next to this app. Android has nothing to compare it with and would install it whoever signed it. Before you restore your wallet into it, check who signed it: install AppVerifier (from F-Droid or Accrescent), open it, pick ${appId}, and compare its SHA-256 with the one below. If they differ, uninstall it and restore nothing.`}
        </Notice>
      ) : null}
      <AppButton
        title="Download"
        icon={Download}
        accessibilityLabel={`Download Trikey ${version} in the browser`}
        onPress={() => {
          // Checked when GitHub's answer was read, and again here: only this repository's release files are opened.
          if (isReleaseDownloadUrl(release.apkUrl)) open(release.apkUrl);
        }}
      />
      {newApp ? null : (
        <Text className="text-muted-foreground text-[13px] leading-[18px]">
          Android installs it over this app, and keeps your wallet, only if it is signed with the same key as this app (the
          Trikey release key, 0.1.7 and later); an APK signed by anyone else is refused. Back up first.
        </Text>
      )}
      <View
        className="gap-0.5"
        accessible
        accessibilityLabel={`Every Trikey release is signed by the certificate with SHA-256 ${FINGERPRINT}`}
      >
        <View className="flex-row items-center gap-1.5">
          <Icon as={ShieldCheck} size={14} className="text-muted-foreground" />
          <Text className="text-muted-foreground text-[13px] leading-[18px]">Signed by (certificate SHA-256)</Text>
        </View>
        <Text selectable className="font-mono text-xs leading-[18px]">
          {FINGERPRINT}
        </Text>
        <Text className="text-muted-foreground text-[13px] leading-[18px]">
          Built into this app: every Trikey release, standard and FOSS, is signed by this certificate and no other. Android
          does not show the signer when it installs; AppVerifier shows it for an installed app.
        </Text>
      </View>
      <AppButton title="Open the release page" icon={ExternalLink} variant="ghost" onPress={() => open(release.pageUrl)} />
    </>
  );
}
