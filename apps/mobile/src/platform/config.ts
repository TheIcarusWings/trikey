// Publisher-supplied configuration, read from the environment at build time.
//
// Expo inlines `process.env.EXPO_PUBLIC_*` only when the variable is written out in full, so
// every read below must stay a literal property access. Nothing here has a default: an unset
// value switches the feature off instead of pointing it at somebody else's account.

/** OAuth client ID of the publisher's Google Cloud project (a "Web application" client). Not a secret. */
export function googleOAuthClientId(raw: string | undefined = process.env.EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID): string | null {
  const id = raw?.trim();
  if (!id) return null;
  // Real client IDs look like 1234-abc.apps.googleusercontent.com. Reject obvious placeholders.
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(id)) return null;
  return id;
}

/**
 * The passkey relying party id: a domain the publisher controls and hosts the
 * apple-app-site-association and assetlinks.json files on. Returns null if unset or malformed
 * (a URL, a port, a path, no dot), so a typo disables passkeys instead of failing at the prompt.
 */
export function passkeyRpId(raw: string | undefined = process.env.EXPO_PUBLIC_PASSKEY_RP_ID): string | null {
  const id = raw?.trim().toLowerCase();
  if (!id) return null;
  if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(id)) return null;
  if (/^[0-9.]+$/.test(id)) return null; // an IP address is not a valid relying party id
  return id;
}
