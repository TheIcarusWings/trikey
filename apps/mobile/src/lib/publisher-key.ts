/**
 * Trikey's publisher key, built into the app: the hex of the npub in packaging/release-signer.npub (a test checks they
 * are equal). It signs every release's manifest (docs/design/signed-releases.md) and the preview unlock
 * (preview-unlock.ts). From 0.1.28-alpha it is the founder's own key (docs/design/publisher-key-switch.md).
 *
 * Changing it needs an app release: an app checks only against the key it was built with.
 */
export const PUBLISHER_PUBKEY = '2ac413fd31b7f60945a22ec4f04f8c907dc210a52c51bfcb64e9a070dc4b979d';
