import { createCloudBackupStore, type CloudBackend, type TrikeyCloudBackupStore } from './store';

/** In-memory stand-in for web previews and tests. Lost on reload; `isSecure` is false. */
export function createMemoryBackend(): CloudBackend & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    provider: 'file',
    files,
    async available() {
      return true;
    },
    async put(name, data) {
      files.set(name, new Uint8Array(data));
    },
    async get(name) {
      const f = files.get(name);
      return f ? new Uint8Array(f) : null;
    },
    async names() {
      return [...files.keys()];
    },
    async delete(name) {
      files.delete(name);
    },
  };
}

export function createMemoryBackupStore(): TrikeyCloudBackupStore {
  return createCloudBackupStore(createMemoryBackend(), { isSecure: false });
}
