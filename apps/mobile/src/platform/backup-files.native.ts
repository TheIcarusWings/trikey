// iOS and Android: the OS share sheet (Files, AirDrop, mail to yourself) and the system document picker.
// The backup file is encrypted; it is useless without the recovery code (and the code is useless without the file).
import { WalletServiceError } from '../data/errors';
import type { PickedFile } from './backup-files';

export type { PickedFile };

/**
 * The cache folder a shared backup is written to, and nothing else. It is emptied before each share and every time the
 * app starts (`clearSharedBackups`), not right after the share sheet closes: on Android the app that receives the file
 * (a mail app, a drive) may only read it after control comes back here. So a shared backup lives on this phone, outside
 * the wallet's own storage, for at most the rest of that app session (security review, docs/security/entropy-review.md I5).
 */
const SHARE_FOLDER = 'trikey-backup-share';

/** Deletes the backups written for sharing. Best effort: never throws. */
export async function clearSharedBackups(): Promise<void> {
  try {
    const fs = await import('expo-file-system');
    const dir = new fs.Directory(fs.Paths.cache, SHARE_FOLDER);
    if (dir.exists) dir.delete();
  } catch {
    // Nothing to do: the OS clears the cache folder on its own when it needs the space.
  }
}

/** Writes the backup into its own cache folder and opens the share sheet on it. */
export async function shareBackupFile(name: string, bytes: Uint8Array): Promise<void> {
  const [fs, Sharing] = await Promise.all([import('expo-file-system'), import('expo-sharing')]);
  if (!(await Sharing.isAvailableAsync())) throw new WalletServiceError('not_available', "This phone can't open the share sheet from here.");
  await clearSharedBackups();
  const dir = new fs.Directory(fs.Paths.cache, SHARE_FOLDER);
  dir.create({ intermediates: true, idempotent: true });
  const file = new fs.File(dir, name);
  file.create({ overwrite: true });
  await file.write(bytes);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/octet-stream', dialogTitle: 'Save your Trikey backup', UTI: 'public.data' });
}

/** Opens the system file chooser; null if the person backed out. */
export async function pickBackupFile(): Promise<PickedFile | null> {
  const [fs, Picker] = await Promise.all([import('expo-file-system'), import('expo-document-picker')]);
  const result = await Picker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  const copy = new fs.File(asset.uri);
  const bytes = new Uint8Array(await copy.bytes());
  // The picker copied the file into the cache; the bytes are read, so the copy goes.
  try {
    copy.delete();
  } catch {
    // Best effort, as above.
  }
  return { name: asset.name, bytes };
}
