import type { ConfigContext, ExpoConfig } from 'expo/config';

// Expo reads app.json first and passes it in as `config`; this file adds what depends on the
// environment: the publisher's iCloud container, passkey domain and app identifiers. The defaults
// are the Trikey project's own (bundle id app.trikey.wallet); a fork sets its own through the
// environment. See "Publishing your own build" in README.md.

/**
 * Same rule as `passkeyRpId` in src/platform/config.ts (duplicated: Expo's config loader does not
 * compile other TypeScript files). A bare domain name, no scheme, port or path.
 */
function validRpId(raw: string | undefined): string | null {
  const id = raw?.trim().toLowerCase();
  if (!id || /^[0-9.]+$/.test(id)) return null;
  return /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(id) ? id : null;
}

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

/**
 * Android's versionCode from the app version: 0.1.6 is 106, 1.2.3 is 10203. Android installs an update only over a
 * lower or equal code, and update tools (Obtainium) compare it, so it must grow with every release.
 */
export function androidVersionCode(version: string | undefined): number {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!m || Number(m[2]) > 99 || Number(m[3]) > 99) throw new Error(`app.json version must be x.y.z with y and z below 100, not ${version}`);
  return Number(m[1]) * 10_000 + Number(m[2]) * 100 + Number(m[3]);
}

type PluginEntry = string | [string, Record<string, unknown>];
const pluginName = (p: PluginEntry) => (Array.isArray(p) ? p[0] : p);

export default ({ config }: ConfigContext): ExpoConfig => {
  const iosBundleId = env('TRIKEY_IOS_BUNDLE_ID') ?? config.ios?.bundleIdentifier;
  const androidPackage = env('TRIKEY_ANDROID_PACKAGE') ?? config.android?.package;
  const rpId = validRpId(process.env.EXPO_PUBLIC_PASSKEY_RP_ID); // null when unset or malformed
  const icloudEnabled = env('TRIKEY_DISABLE_ICLOUD') !== '1';

  const plugins: PluginEntry[] = [
    // Development build instead of Expo Go: secure storage, passkeys and iCloud are native modules.
    'expo-dev-client',
    // Adds NSFaceIDUsageDescription (needed for `requireAuthentication`) and keeps the Keystore
    // entries out of Android cloud backups.
    [
      'expo-secure-store',
      {
        faceIDPermission:
          config.ios?.infoPlist?.NSFaceIDUsageDescription ??
          "Trikey asks for Face ID before it signs a payment with this phone's key.",
      },
    ],
  ];
  if (icloudEnabled) {
    // iCloud Drive container entitlement and NSUbiquitousContainers, for the iOS cloud backup.
    // The Android side of this package needs no configuration.
    plugins.push([
      'react-native-cloud-storage',
      {
        iCloudContainerIdentifier: env('TRIKEY_ICLOUD_CONTAINER') ?? `iCloud.${iosBundleId}`,
        iCloudContainerEnvironment: env('TRIKEY_ICLOUD_ENVIRONMENT') === 'Development' ? 'Development' : 'Production',
      },
    ]);
  }

  const existing = (config.plugins ?? []) as PluginEntry[];
  const have = new Set(existing.map(pluginName));

  return {
    ...config,
    name: config.name ?? 'Trikey',
    slug: config.slug ?? 'trikey',
    ios: {
      ...config.ios,
      bundleIdentifier: iosBundleId,
      ...(env('TRIKEY_APPLE_TEAM_ID') ? { appleTeamId: env('TRIKEY_APPLE_TEAM_ID') } : {}),
      // Passkeys: the app must be associated with the relying party's domain. The domain also has
      // to serve /.well-known/apple-app-site-association (see docs/passkeys.md).
      ...(rpId ? { associatedDomains: [...(config.ios?.associatedDomains ?? []), `webcredentials:${rpId}`] } : {}),
    },
    android: {
      ...config.android,
      package: androidPackage,
      versionCode: config.android?.versionCode ?? androidVersionCode(config.version),
    },
    plugins: [...existing, ...plugins.filter((p) => !have.has(pluginName(p)))],
  };
};
