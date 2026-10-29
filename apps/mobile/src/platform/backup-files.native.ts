// iOS and Android: the OS share sheet (Files, AirDrop, mail to yourself) and the system document picker.
// The backup file is encrypted; it is useless without the recovery code (and the code is useless without the file).
import { WalletServiceError } from '../data/errors';
import type { PickedFile } from './backup-files';

export type { PickedFile };

/** Writes the backup into the cache folder and opens the share sheet on it. */
export async function shareBackupFile(name: string, bytes: Uint8Array): Promise<void> {
  const [fs, Sharing] = await Promise.all([import('expo-file-system'), import('expo-sharing')]);
  if (!(await Sharing.isAvailableAsync())) throw new WalletServiceError('not_available', "This phone can't open the share sheet from here.");
  const file = new fs.File(fs.Paths.cache, name);
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
  const bytes = new Uint8Array(await new fs.File(asset.uri).bytes());
  return { name: asset.name, bytes };
}
