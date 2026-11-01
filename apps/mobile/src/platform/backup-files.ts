// Web version: the browser's download and file chooser. `backup-files.native.ts` is what iOS and Android load.
// The backup file is encrypted; it is useless without the recovery code (and the code is useless without the file).

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

/** Hands the backup file to the person: the browser downloads it. */
export async function shareBackupFile(name: string, bytes: Uint8Array): Promise<void> {
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Nothing to clear on the web: the browser hands the file straight to its downloads (see the native version). */
export async function clearSharedBackups(): Promise<void> {}

/** Lets the person choose a backup file; null if they closed the chooser. */
export function pickBackupFile(): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tkb,application/octet-stream';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
