// iOS and Android: files for a hardware wallet's microSD card (Passport gen 2 and Krux sign Trikey's texts from a file:
// apps/mobile/src/hardware/qr/sd-message.ts). The request file is written straight into a folder the owner picks (the
// card in a USB-C or Lightning reader, or Files), or handed to the share sheet (to a computer, mail to yourself); the
// signed file comes back through the system document picker. Nothing here needs Google code: the folder and file
// pickers are the system's own (Android's Storage Access Framework), so the FOSS build has them too.
//
// The request file holds the text to sign (the wallet id, the guardian's public key), not a key. The copy made for the
// share sheet lives in a cache folder of its own, emptied before each share and at every start, as for the labels file.
import { WalletServiceError } from '../data/errors';
import type { DeviceFile, DeviceFileIo } from '../hardware/qr/bridge';

const SHARE_FOLDER = 'trikey-device-share';
/** The largest file read back: a signed message is well under 1 kB. */
const MAX_BYTES = 64 * 1024;

/** Deletes the files written for sharing. Best effort: never throws. */
export async function clearSharedDeviceFiles(): Promise<void> {
  try {
    const fs = await import('expo-file-system');
    const dir = new fs.Directory(fs.Paths.cache, SHARE_FOLDER);
    if (dir.exists) dir.delete();
  } catch {
    // The OS clears the cache folder on its own when it needs the space.
  }
}

const cancelled = (e: unknown) => /cancel/i.test(e instanceof Error ? e.message : String(e));

/** Asks for a folder (the card) and writes the file into it. False if the owner backed out. */
async function saveToFolder(name: string, text: string): Promise<boolean> {
  const fs = await import('expo-file-system');
  let dir: InstanceType<typeof fs.Directory>;
  try {
    dir = await fs.Directory.pickDirectoryAsync();
  } catch (e) {
    if (cancelled(e)) return false;
    throw new WalletServiceError('not_available', "This phone can't open a folder from here. Share the file instead.", { cause: e });
  }
  if (!dir) return false;
  const file = dir.createFile(name, 'text/plain');
  await file.write(text);
  return true;
}

/** Writes the file into its own cache folder and opens the share sheet on it. */
async function share(name: string, text: string): Promise<void> {
  const [fs, Sharing] = await Promise.all([import('expo-file-system'), import('expo-sharing')]);
  if (!(await Sharing.isAvailableAsync())) throw new WalletServiceError('not_available', "This phone can't open the share sheet from here.");
  await clearSharedDeviceFiles();
  const dir = new fs.Directory(fs.Paths.cache, SHARE_FOLDER);
  dir.create({ intermediates: true, idempotent: true });
  const file = new fs.File(dir, name);
  file.create({ overwrite: true });
  await file.write(text);
  await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: `Save ${name} for your hardware wallet`, UTI: 'public.plain-text' });
}

/** Opens the system file chooser for the signed file; null if the owner backed out. */
async function pick(): Promise<DeviceFile | null> {
  const [fs, Picker] = await Promise.all([import('expo-file-system'), import('expo-document-picker')]);
  const result = await Picker.getDocumentAsync({ type: ['text/plain', '*/*'], copyToCacheDirectory: true, multiple: false });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  const copy = new fs.File(asset.uri);
  try {
    if (asset.size !== undefined && asset.size !== null && asset.size > MAX_BYTES) throw new WalletServiceError('invalid_input', 'That file is too large to be a signed message.');
    return { name: asset.name, bytes: new Uint8Array(await copy.bytes()) };
  } finally {
    try {
      copy.delete();
    } catch {
      // Best effort, as for the labels file.
    }
  }
}

/** The app's file I/O for the QR sheet's microSD requests (`QrBridgeHost`). */
export const deviceFileIo: DeviceFileIo = { saveToFolder, share, pick };
