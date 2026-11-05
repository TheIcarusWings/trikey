// iOS and Android: the OS share sheet and the system document picker for BIP 329 labels files (Settings > Wallet details).
// A labels file is not a key, but it is private (which coins and payments are yours, and what you called them): it is
// written to a cache folder of its own only to be shared, and that folder is emptied before each share and at every
// start, as for the backup file.
import { WalletServiceError } from '../data/errors';
import type { PickedFile } from './backup-files';

const SHARE_FOLDER = 'trikey-labels-share';
/** The largest labels file read (the wallet refuses anything larger too). */
const MAX_BYTES = 8 * 1024 * 1024;

/** Deletes the labels files written for sharing. Best effort: never throws. */
export async function clearSharedLabels(): Promise<void> {
  try {
    const fs = await import('expo-file-system');
    const dir = new fs.Directory(fs.Paths.cache, SHARE_FOLDER);
    if (dir.exists) dir.delete();
  } catch {
    // The OS clears the cache folder on its own when it needs the space.
  }
}

/** Writes the labels into their own cache folder and opens the share sheet on them. */
export async function shareLabelsFile(name: string, text: string): Promise<void> {
  const [fs, Sharing] = await Promise.all([import('expo-file-system'), import('expo-sharing')]);
  if (!(await Sharing.isAvailableAsync())) throw new WalletServiceError('not_available', "This phone can't open the share sheet from here.");
  await clearSharedLabels();
  const dir = new fs.Directory(fs.Paths.cache, SHARE_FOLDER);
  dir.create({ intermediates: true, idempotent: true });
  const file = new fs.File(dir, name);
  file.create({ overwrite: true });
  await file.write(text);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Export labels (BIP 329)', UTI: 'public.json' });
}

/** Opens the system file chooser for a labels file; null if the person backed out. */
export async function pickLabelsFile(): Promise<PickedFile | null> {
  const [fs, Picker] = await Promise.all([import('expo-file-system'), import('expo-document-picker')]);
  const result = await Picker.getDocumentAsync({ type: ['application/json', 'application/jsonl', 'text/plain', '*/*'], copyToCacheDirectory: true, multiple: false });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  if (asset.size !== undefined && asset.size !== null && asset.size > MAX_BYTES) throw new WalletServiceError('invalid_input', 'That file is too large to be a labels file.');
  const copy = new fs.File(asset.uri);
  const bytes = new Uint8Array(await copy.bytes());
  try {
    copy.delete();
  } catch {
    // Best effort, as for the backup file.
  }
  return { name: asset.name, bytes };
}
