import type { AndroidVariant } from './android-variant';

/**
 * Up to 0.1.21 the Android build without Google code had the standard app's application id, so it replaced it. Now it
 * is its own app (app.trikey.wallet.foss, "Trikey FOSS"; android-variant.js), and Android cannot update the old one to
 * it: the new app starts empty while the wallet is still in the old one. The old app cannot be told, so the new app's
 * first screen says it: restoring the backup is what moves the wallet. Only on the FOSS Android app, and only on Welcome
 * (a phone with a wallet in this app never sees it).
 */
export function fossMigrationNote(os: string, variant: AndroidVariant): { link: string; title: string; body: string } | null {
  if (os !== 'android' || variant !== 'foss') return null;
  return {
    link: 'Used Trikey without Google before?',
    title: 'Your wallet is still in the old app',
    body:
      'Up to 0.1.21, Trikey without Google replaced the standard Trikey app. Now it is its own app, Trikey FOSS, and it ' +
      "can't see the old app's wallet. To move it here, tap \"I already have a Trikey wallet\", then \"My phone, but I have " +
      'its backup\", and open your backup file with your recovery code (a Recovery Key wallet: "I have a Recovery Kit"). ' +
      'Keep the old app until your wallet shows here, then uninstall it.',
  };
}
