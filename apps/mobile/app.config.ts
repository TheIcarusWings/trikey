import type { ConfigContext, ExpoConfig } from 'expo/config';

// Expo reads app.json first and passes it in as `config`; this file adds what depends on the
// environment: the publisher's iCloud container, passkey domain and app identifiers. Nothing
// here is a real account: every value is either read from the environment or a placeholder
// that fails loudly when it reaches Apple's or Google's tooling. See "Publishing your own build"
// in README.md.

/** Placeholder container id. Replace it (TRIKEY_ICLOUD_CONTAINER) with `iCloud.<your bundle id>`. */
const PLACEHOLDER_ICLOUD_CONTAINER = 'iCloud.com.example.replace-me.trikey';

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
        iCloudContainerIdentifier: env('TRIKEY_ICLOUD_CONTAINER') ?? PLACEHOLDER_ICLOUD_CONTAINER,
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
    },
    plugins: [...existing, ...plugins.filter((p) => !have.has(pluginName(p)))],
  };
};
