# Android signing and updates

From **0.1.6-alpha**, every release APK is signed with the same key: the Trikey release key. Android installs an APK over
an installed app only when both have the same signature, so a new release now updates the app in place and the wallet on
the phone stays. Builds up to 0.1.5-alpha were signed with a one-off key each, so moving from one of those to 0.1.6-alpha
needs one last uninstall (which deletes the wallet on that phone: make a backup first).

Pull-request builds and manual runs of the **Android test APK** workflow still get a one-off key: they never see the release
key, and they cannot update a release build or be updated by one.

## The release key's certificate

Its SHA-256 is in [`packaging/android/release-cert.sha256`](../packaging/android/release-cert.sha256). The release build
refuses to publish an APK signed by anything else, and each release's notes repeat it. To check an APK yourself (Android
SDK build tools):

```sh
apksigner verify --print-certs trikey-alpha-v0.1.6-alpha.apk | grep 'SHA-256'
```

The digest it prints must equal the one in that file.

## Updates without downloading by hand

[Obtainium](https://github.com/ImranR98/Obtainium) watches a GitHub repository's releases and installs new APKs:

1. Install Obtainium (from its GitHub releases or F-Droid).
2. **Add app**, URL `https://github.com/TheIcarusWings/trikey`. Under the source options, turn on **Include prereleases**:
   every Trikey release is a pre-release for now.
3. Optionally, under **Verify the certificate**, paste the SHA-256 from `packaging/android/release-cert.sha256`, so
   Obtainium refuses an APK signed by another key. Android refuses such an update anyway.

Obtainium then shows when a release is out, and installs it with one tap.

## For the maintainer: the key

The key lives only in two places: the repository's Actions secrets, for the build, and the maintainer's own backup.
Neither the repository nor any artifact or log ever contains it.

- **Losing it** means no release can update an installed app again: every tester would have to uninstall once more.
  Keep the `.p12` file and its password backed up (a password manager, plus an offline copy).
- **Leaking it** lets someone sign an APK that Android would accept as an update of Trikey. They would still need the
  user to install it, but treat a leak as serious: make a new key, tell testers, and change the pinned certificate.

### Making it (once, on a Mac or Linux)

```sh
mkdir -p ~/trikey-signing && cd ~/trikey-signing && umask 077
openssl req -x509 -newkey rsa:4096 -sha256 -days 10950 -nodes \
  -keyout key.pem -out cert.pem -subj "/CN=Trikey release/O=Trikey"
openssl pkcs12 -export -inkey key.pem -in cert.pem -name trikey -out trikey-release.p12 \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
rm key.pem
openssl x509 -in cert.pem -noout -fingerprint -sha256
```

The `pkcs12` step asks for a password twice: use a long random one and keep it in your password manager. The last line
prints the certificate's SHA-256: that goes in `packaging/android/release-cert.sha256`. It is public, so it can be in the
repository. Back up `trikey-release.p12` (and the password) before anything else.

### Giving it to the build

In the repository, **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
| --- | --- |
| `ANDROID_RELEASE_KEYSTORE` | the `.p12` file in base64: `base64 -i trikey-release.p12 \| pbcopy` on a Mac copies it (Linux: `base64 -w0 trikey-release.p12`) |
| `ANDROID_RELEASE_KEYSTORE_PASSWORD` | the password |
| `ANDROID_RELEASE_KEY_ALIAS` | optional; only if the key's alias is not `trikey` |

The build (`.github/workflows/android-build.yml`) decodes the keystore into the runner's temporary folder, signs, deletes
it, and checks the APK's certificate against `packaging/android/release-cert.sha256`. Only the build job of a release tag
gets these secrets (`.github/workflows/android-apk.yml`).

These are not the SSH or GPG keys on a GitHub account: those sign commits and log in to GitHub. An Android app is signed
with its own key, made as above.
