// Web version: the browser's download and file chooser. `device-files.native.ts` is what iOS and Android load.
// Files for a hardware wallet's microSD card (Passport gen 2, Krux: apps/mobile/src/hardware/qr/sd-message.ts): the
// request file is downloaded, to be copied onto the card; the signed file comes back through the file chooser.
import type { DeviceFile, DeviceFileIo } from '../hardware/qr/bridge';

/** Nothing to clear on the web (see the native version). */
export async function clearSharedDeviceFiles(): Promise<void> {}

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function pick(): Promise<DeviceFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,text/plain';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** The browser saves to its downloads folder: "save" and "share" both download the file. */
export const deviceFileIo: DeviceFileIo = {
  saveToFolder: async (name, text) => {
    download(name, text);
    return true;
  },
  share: async (name, text) => download(name, text),
  pick,
};
