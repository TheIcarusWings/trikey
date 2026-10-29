import type * as ExpoFileSystem from 'expo-file-system';
import { nativeModules } from '../native-modules';
import { createCloudBackupStore, type CloudBackend, type TrikeyCloudBackupStore } from './store';

/** The slice of `expo-file-system` this provider uses. Tests pass a fake backed by a temp dir. */
export type FileSystemModule = Pick<typeof ExpoFileSystem, 'File' | 'Directory' | 'Paths'>;

const TMP_SUFFIX = '.tmp';
const OLD_SUFFIX = '.old';

/**
 * The `file` provider: a folder in the app's document directory. For development and for
 * devices with no cloud account; the backup does not leave the phone, so it does not protect
 * against losing the phone. Not available on web.
 *
 * Writes are atomic: the bytes go to `<name>.tmp` and are then moved over `<name>`, so a crash
 * in the middle leaves the previous backup in place. (`createCloudBackupStore` also reads the
 * file back and compares it.)
 */
export function createFileBackend(opts: {
  load?: () => Promise<FileSystemModule>;
  directoryName?: string;
} = {}): CloudBackend {
  const load = opts.load ?? (() => nativeModules.loadFileSystem());
  const directoryName = opts.directoryName ?? 'trikey-backups';

  async function open() {
    const fs = await load();
    const dir = new fs.Directory(fs.Paths.document, directoryName);
    dir.create({ intermediates: true, idempotent: true });
    return { fs, dir };
  }

  return {
    provider: 'file',

    async available() {
      try {
        await open();
        return true;
      } catch {
        return false;
      }
    },

    async put(name, data) {
      const { fs, dir } = await open();
      const tmp = new fs.File(dir, name + TMP_SUFFIX);
      tmp.create({ overwrite: true });
      await tmp.write(data);
      const final = new fs.File(dir, name);
      try {
        await tmp.move(final, { overwrite: true });
      } catch (e) {
        if (!final.exists) throw e;
        // The platform refused to move over an existing file. Park the old backup, move the new
        // one in, and put the old one back if that fails too, so a failure never loses a backup.
        const old = new fs.File(dir, name + OLD_SUFFIX);
        if (old.exists) old.delete();
        await final.move(old, { overwrite: true });
        try {
          await tmp.move(new fs.File(dir, name), { overwrite: true });
        } catch (e2) {
          await old.move(new fs.File(dir, name), { overwrite: true });
          throw e2;
        }
        old.delete();
      }
    },

    async get(name) {
      const { fs, dir } = await open();
      const file = new fs.File(dir, name);
      if (!file.exists) return null;
      return new Uint8Array(await file.bytes());
    },

    async names() {
      const { fs, dir } = await open();
      return dir
        .list()
        .filter((item): item is ExpoFileSystem.File => item instanceof fs.File)
        .map((f) => f.name)
        .filter((n) => !n.endsWith(TMP_SUFFIX) && !n.endsWith(OLD_SUFFIX));
    },

    async delete(name) {
      const { fs, dir } = await open();
      const file = new fs.File(dir, name);
      if (file.exists) file.delete();
    },
  };
}

export function createFileBackupStore(opts: Parameters<typeof createFileBackend>[0] = {}): TrikeyCloudBackupStore {
  return createCloudBackupStore(createFileBackend(opts));
}
