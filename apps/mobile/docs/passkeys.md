# Passkeys for the backup

The cloud backup of key 2 is encrypted with a random data key. That data key is wrapped by a
**passkey** using the WebAuthn **PRF** extension: the passkey turns a fixed salt into a 32-byte secret
that only it can produce, and that secret wraps the data key. The passkey syncs through iCloud
Keychain or Google Password Manager, so a new phone can unlock the backup with it.

There is no server: the challenge is random and never checked. The passkey is only a key-derivation
device. But passkeys still belong to a **relying party ID** (RP ID), which must be a domain that
**you** control and that vouches for your app. This file is what you have to host.

## What you need

| | |
|---|---|
| A domain | `trikey.app` for the Trikey project's own builds; a fork uses its own. Bare host name, no `https://`, no path. This is the RP ID. |
| HTTPS on that domain | Valid certificate, **no redirects** on the two files below. |
| `apple-app-site-association` | iOS: lists your app under `webcredentials`. |
| `assetlinks.json` | Android: lists your app and its signing-key fingerprint. |
| `EXPO_PUBLIC_PASSKEY_RP_ID` | Set to the domain at build time. Unset means passkeys are switched off. |

Phones: iOS 18 or later, and Android 9 (API 28) or later with Google Play services. PRF also depends on
the user's passkey provider: iCloud Keychain and Google Password Manager return it; some third-party
providers do not. When a provider does not, `PasskeyPrf.create` fails with `prf-unavailable` and the
wallet should offer another way to unlock the backup.

> **Pick the domain once.** A passkey is bound to its RP ID forever. If you change the domain, or stop
> hosting these files, passkeys created under the old one stop working and backups wrapped by them can
> no longer be opened. Use a domain you will keep.

## 1. iOS: `apple-app-site-association`

Serve this at `https://<RP ID>/.well-known/apple-app-site-association` with
`Content-Type: application/json`, no `.json` extension, no redirect:

```json
{
  "webcredentials": {
    "apps": ["ABCDE12345.com.yourcompany.trikey"]
  }
}
```

- `ABCDE12345` is your **Apple Team ID** (Apple Developer account, Membership).
- `com.yourcompany.trikey` is the **bundle identifier** (`TRIKEY_IOS_BUNDLE_ID`, or `ios.bundleIdentifier` in `app.json`).
- List one entry per build variant if you ship several bundle ids.

The app side is already done: when `EXPO_PUBLIC_PASSKEY_RP_ID` is set, `app.config.ts` adds the
associated domain `webcredentials:<RP ID>` to the entitlements. Your Apple App ID needs the
**Associated Domains** capability enabled (EAS and Xcode automatic signing do this for you).

Check it: open `https://app-site-association.cdn-apple.com/a/v1/<RP ID>` and look for your app id. Apple
caches the file in its CDN, so a change can take a while to show up. For development builds you can skip
the cache by building with the entitlement `webcredentials:<RP ID>?mode=developer` and turning on
Settings > Developer > Associated Domains Development on the phone.

## 2. Android: `assetlinks.json`

Serve this at `https://<RP ID>/.well-known/assetlinks.json` with `Content-Type: application/json`, no redirect:

```json
[
  {
    "relation": ["delegate_permission/common.get_login_creds"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.yourcompany.trikey",
      "sha256_cert_fingerprints": [
        "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
      ]
    }
  }
]
```

- `package_name` is the Android package (`TRIKEY_ANDROID_PACKAGE`, or `android.package` in `app.json`).
- `sha256_cert_fingerprints` is the SHA-256 of the key that **signs the build the user installs**.
  List every one you use:
  - the debug keystore, for development builds (`keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`);
  - your upload key, for builds you install yourself;
  - the **app signing key** shown in Play Console under Setup > App signing, for builds from Google Play.
- No manifest change is needed in the app: Credential Manager reads this file by itself.

Check it:
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://<RP ID>&relation=delegate_permission/common.get_login_creds`
should return your statement.

## 3. Build with the domain

```sh
EXPO_PUBLIC_PASSKEY_RP_ID=trikey.app npx expo prebuild   # or set it in .env / your EAS secrets
```

Then in a development build, `platform.passkeys.isSupported()` is `true` on a capable phone.

## What goes wrong

| Symptom | Likely cause |
|---|---|
| `isSupported()` is `false` | `EXPO_PUBLIC_PASSKEY_RP_ID` empty or not a bare domain; iOS below 18; Android below 9; Expo Go (needs a development build). |
| `bad-configuration` | The domain does not serve the file, serves it through a redirect, lists a different Team ID, bundle id, package or fingerprint, or the Apple CDN has not refreshed yet. |
| `prf-unavailable` | The passkey provider (for example a password manager that stores passkeys) does not implement PRF. Use iCloud Keychain or Google Password Manager. |
| `cancelled` | The user dismissed the prompt. Not an error to report. |
| `no-credential` | No Trikey passkey on this phone: it was never created here and has not synced. |
