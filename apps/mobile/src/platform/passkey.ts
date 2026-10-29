import type { PasskeyPrf } from '@trikey/wallet';
import { secureRandomBytes } from '@trikey/core/random';
import { base64ToBytes, bytesToBase64Url } from './bytes';
import { PasskeyError, passkeyError } from './errors';
import { nativeModules, type NativeModuleLoaders } from './native-modules';

export type TrikeyPasskeyPrf = PasskeyPrf & { readonly isSecure: boolean };

/** iOS added the WebAuthn PRF extension to `ASAuthorization` in iOS 18. */
export const MIN_IOS_MAJOR = 18;
/**
 * Android's Credential Manager is available from API 28 (through Google Play services), which is
 * also `react-native-passkey`'s floor. Whether the user's passkey provider returns PRF results
 * depends on the provider; that is only known when a passkey is created, and `create` reports it
 * as `prf-unavailable`. Check on real devices before raising or lowering this.
 */
export const MIN_ANDROID_API = 28;

/** Whether this OS version can do passkeys with PRF. `version` is `Platform.Version`. */
export function osSupportsPasskeyPrf(os: string, version: string | number): boolean {
  if (os === 'ios') return parseInt(String(version), 10) >= MIN_IOS_MAJOR;
  if (os === 'android') return Number(version) >= MIN_ANDROID_API;
  return false;
}

const PRF_BYTES = 32;

type PasskeyModule = Awaited<ReturnType<NativeModuleLoaders['loadPasskey']>>;
type CreateResult = Awaited<ReturnType<PasskeyModule['Passkey']['create']>>;

/** `react-native-passkey` rejects with plain `{ error, message }` objects, not `Error`s. */
export function mapPasskeyError(err: unknown): PasskeyError {
  if (err instanceof PasskeyError) return err;
  const e = err as { error?: unknown; message?: unknown } | null;
  const kind = typeof e?.error === 'string' ? e.error : '';
  const message = typeof e?.message === 'string' ? e.message : err instanceof Error ? err.message : '';
  const opts = { cause: err, detail: (message || kind || 'unknown error').slice(0, 200) };

  if (/rp id|not associated|assetlinks|app-site-association/i.test(message) && kind !== 'UserCancelled') {
    return passkeyError('bad-configuration', opts);
  }
  switch (kind) {
    case 'UserCancelled':
    case 'Interrupted':
      return passkeyError('cancelled', opts);
    case 'NoCredentials':
      return passkeyError('no-credential', opts);
    case 'BadConfiguration':
      return passkeyError('bad-configuration', opts);
    case 'CredentialAlreadyExists':
      return passkeyError('already-exists', opts);
    case 'TimedOut':
      return passkeyError('timeout', opts);
    case 'NotSupported':
    case 'NoCreateOption':
      return passkeyError('unsupported', opts);
    default:
      return passkeyError('failed', opts);
  }
}

function challengeBytes(n: number): Uint8Array {
  try {
    return secureRandomBytes(n);
  } catch (e) {
    throw passkeyError('failed', { detail: e instanceof Error ? e.message : String(e) });
  }
}

function decodePrf(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const bytes = base64ToBytes(value);
    return bytes.length === PRF_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Passkeys with the WebAuthn PRF extension, on `react-native-passkey` (3.3+ added PRF for
 * iOS 18+ and Android's Credential Manager).
 *
 * The PRF output is a 32-byte secret that only the passkey can produce for a given `salt`. The
 * wallet uses it to wrap the backup's data key, so the backup can be opened on any device the
 * passkey syncs to (iCloud Keychain, Google Password Manager).
 *
 * `rpId` is the relying party id: a domain the publisher controls, which must host the
 * `apple-app-site-association` and `assetlinks.json` files. When it is null, nothing works and
 * `isSupported()` is false. See `docs/passkeys.md`.
 *
 * There is no server, so the WebAuthn challenge is random and never verified: the passkey is
 * used only as a key-derivation device, not to authenticate to anyone.
 */
export function createPasskeyPrf(opts: {
  rpId: string | null;
  os: string;
  osVersion: string | number;
  load?: NativeModuleLoaders['loadPasskey'];
  rpName?: string;
}): TrikeyPasskeyPrf {
  const load = opts.load ?? nativeModules.loadPasskey;
  const rpName = opts.rpName ?? 'Trikey';

  async function sdk(): Promise<PasskeyModule['Passkey'] | null> {
    if (!opts.rpId || !osSupportsPasskeyPrf(opts.os, opts.osVersion)) return null;
    try {
      const { Passkey } = await load();
      return Passkey.isSupported() ? Passkey : null;
    } catch {
      return null;
    }
  }

  async function requireSdk(): Promise<{ Passkey: PasskeyModule['Passkey']; rpId: string }> {
    const Passkey = await sdk();
    if (!Passkey || !opts.rpId) throw passkeyError('unsupported');
    return { Passkey, rpId: opts.rpId };
  }

  function prfFrom(result: CreateResult | { clientExtensionResults?: CreateResult['clientExtensionResults'] }) {
    return result.clientExtensionResults?.prf;
  }

  const store: TrikeyPasskeyPrf = {
    isSecure: true,

    async isSupported() {
      return (await sdk()) !== null;
    },

    async create({ userName, salt }) {
      if (!(salt instanceof Uint8Array) || salt.length === 0) throw new TypeError('salt must be non-empty bytes');
      const { Passkey, rpId } = await requireSdk();
      let created: CreateResult;
      try {
        created = await Passkey.create({
          challenge: bytesToBase64Url(challengeBytes(32)),
          rp: { id: rpId, name: rpName },
          user: { id: bytesToBase64Url(challengeBytes(16)), name: userName, displayName: userName },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 }, // ES256
            { type: 'public-key', alg: -257 }, // RS256, for providers that need it
          ],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          attestation: 'none',
          extensions: { prf: { eval: { first: new Uint8Array(salt) } } },
        });
      } catch (e) {
        throw mapPasskeyError(e);
      }

      const prf = prfFrom(created);
      if (!prf?.enabled && !prf?.results?.first) throw passkeyError('prf-unavailable');
      const credentialId = created.id;
      // Providers may enable PRF at creation without returning the output (the spec allows it).
      // Then evaluate it with a second request on the new credential.
      const direct = decodePrf(prf.results?.first);
      if (direct) return { credentialId, prfOutput: direct };
      const again = await store.get({ credentialId, salt });
      return { credentialId, prfOutput: again.prfOutput };
    },

    async get({ credentialId, salt }) {
      if (!(salt instanceof Uint8Array) || salt.length === 0) throw new TypeError('salt must be non-empty bytes');
      const { Passkey, rpId } = await requireSdk();
      let result: Awaited<ReturnType<PasskeyModule['Passkey']['get']>>;
      try {
        result = await Passkey.get({
          challenge: bytesToBase64Url(challengeBytes(32)),
          rpId,
          allowCredentials: credentialId ? [{ type: 'public-key', id: credentialId }] : [],
          userVerification: 'required',
          extensions: { prf: { eval: { first: new Uint8Array(salt) } } },
        });
      } catch (e) {
        throw mapPasskeyError(e);
      }
      const output = decodePrf(prfFrom(result)?.results?.first);
      if (!output) throw passkeyError('prf-unavailable');
      return { credentialId: result.id, prfOutput: output };
    },
  };
  return store;
}
