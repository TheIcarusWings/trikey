/**
 * The Trikey Android release key's certificate, built into the app: the SHA-256 in packaging/android/release-cert.sha256
 * (docs/android-signing.md), which a test checks this equals. Every release APK, standard and FOSS, is signed with this
 * key and nothing else (.github/workflows/publish-release.yml refuses to publish one that is not).
 *
 * The update sheet shows it as the signer to expect. It comes from the app the person already trusts, not from the
 * release being offered, so a replaced release file cannot change what the sheet says.
 */
export const RELEASE_CERT_SHA256 = 'c6c46a1332725111413a7b0313e2f2f37b10f0ce4c8da1cac3c92d179a162da7';

/** A SHA-256 as Android tools and AppVerifier print it: upper case, a colon between bytes. */
export function formatFingerprint(hex: string): string {
  const clean = hex.replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(clean)) throw new Error('not a SHA-256');
  return clean.match(/../g)!.join(':');
}
