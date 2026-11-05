// Web version: the browser's download and file chooser. `labels-files.native.ts` is what iOS and Android load.
// A BIP 329 labels file is plain text: it says which coins and payments are yours, and what you called them. Not a key,
// but private: it is handed to the person, never kept here.
import type { PickedFile } from './backup-files';

/** Hands the labels file to the person: the browser downloads it. */
export async function shareLabelsFile(name: string, text: string): Promise<void> {
  const blob = new Blob([text], { type: 'application/jsonl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Nothing to clear on the web (see the native version). */
export async function clearSharedLabels(): Promise<void> {}

/** Lets the person choose a labels file (any text file: wallets name them .jsonl, .json or .txt); null if they closed the chooser. */
export function pickLabelsFile(): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jsonl,.json,.txt,application/jsonl,application/json,text/plain';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
