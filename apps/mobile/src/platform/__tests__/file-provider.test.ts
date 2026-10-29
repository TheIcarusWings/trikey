import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileBackend, createFileBackupStore, type FileSystemModule } from '../cloud/file-provider';
import { createCloudBackupStore } from '../cloud/store';

/**
 * A stand-in for `expo-file-system` (the SDK 54+ `File` / `Directory` / `Paths` API) that works
 * on a real temp directory, so the provider's calls hit an actual filesystem.
 */
function fakeExpoFileSystem(root: string) {
  const resolve = (parts: (string | { path: string })[]) =>
    path.join(...parts.map((p) => (typeof p === 'string' ? p.replace(/^file:\/\//, '') : p.path)));

  class Directory {
    path: string;
    constructor(...parts: (string | { path: string })[]) {
      this.path = resolve(parts);
    }
    get exists() {
      return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
    }
    create(opts: { intermediates?: boolean; idempotent?: boolean } = {}) {
      if (this.exists) {
        if (opts.idempotent) return;
        throw new Error('Directory already exists');
      }
      fs.mkdirSync(this.path, { recursive: !!opts.intermediates });
    }
    list() {
      return fs.readdirSync(this.path).map((n) => {
        const p = path.join(this.path, n);
        return fs.statSync(p).isDirectory() ? new Directory(p) : new File(p);
      });
    }
  }

  class File {
    path: string;
    constructor(...parts: (string | { path: string })[]) {
      this.path = resolve(parts);
    }
    get name() {
      return path.basename(this.path);
    }
    get exists() {
      return fs.existsSync(this.path) && fs.statSync(this.path).isFile();
    }
    create(opts: { overwrite?: boolean } = {}) {
      if (this.exists && !opts.overwrite) throw new Error('File already exists');
      fs.writeFileSync(this.path, new Uint8Array(0));
    }
    async write(content: string | Uint8Array) {
      if (!this.exists) throw new Error('File does not exist');
      fs.writeFileSync(this.path, content);
    }
    async bytes() {
      return new Uint8Array(fs.readFileSync(this.path));
    }
    delete() {
      fs.unlinkSync(this.path);
    }
    async move(dest: File, opts: { overwrite?: boolean } = {}) {
      if (fs.existsSync(dest.path) && !opts.overwrite) throw new Error('Destination already exists');
      fs.renameSync(this.path, dest.path);
      this.path = dest.path;
    }
  }

  return { File, Directory, Paths: { document: new Directory(root) } } as unknown as FileSystemModule;
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trikey-file-provider-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const data = (n: number, fill = 3) => new Uint8Array(n).fill(fill);

describe('file provider', () => {
  it('stores backups as files in a folder under the document directory', async () => {
    const store = createFileBackupStore({ load: async () => fakeExpoFileSystem(root) });
    await store.write('key2.bak', data(100));
    expect(fs.readdirSync(path.join(root, 'trikey-backups'))).toEqual(['key2.bak']);
    expect(new Uint8Array(fs.readFileSync(path.join(root, 'trikey-backups', 'key2.bak')))).toEqual(data(100));
  });

  it('round-trips through the store, including overwrite, list and remove', async () => {
    const store = createFileBackupStore({ load: async () => fakeExpoFileSystem(root) });
    expect(store.provider).toBe('file');
    expect(await store.isAvailable()).toBe(true);
    expect(await store.list()).toEqual([]);
    expect(await store.read('missing')).toBeNull();
    await store.write('a', data(10, 1));
    await store.write('b', data(20, 2));
    await store.write('a', data(30, 9)); // overwrite
    expect(await store.read('a')).toEqual(data(30, 9));
    expect(await store.list()).toEqual(['a', 'b']);
    await store.remove('a');
    await store.remove('a');
    expect(await store.list()).toEqual(['b']);
  });

  it('leaves no temp file behind and never lists one', async () => {
    const load = async () => fakeExpoFileSystem(root);
    const store = createFileBackupStore({ load });
    await store.write('x', data(5));
    expect(fs.readdirSync(path.join(root, 'trikey-backups'))).toEqual(['x']);

    // A leftover from a crash mid-write is invisible and does not break the next write.
    fs.writeFileSync(path.join(root, 'trikey-backups', 'y.tmp'), 'partial');
    expect(await store.list()).toEqual(['x']);
    await store.write('y', data(6));
    expect(await store.read('y')).toEqual(data(6));
    expect(fs.existsSync(path.join(root, 'trikey-backups', 'y.tmp'))).toBe(false);
  });

  it('keeps the previous backup when the move step fails (atomic replace)', async () => {
    const fsModule = fakeExpoFileSystem(root);
    const store = createFileBackupStore({ load: async () => fsModule });
    await store.write('x', data(5, 1));
    const RealFile = fsModule.File;
    // The temp file is written, then the move over the old backup throws.
    (fsModule as { File: unknown }).File = class extends (RealFile as never as new (...a: unknown[]) => object) {
      async move() {
        throw new Error('disk error');
      }
    };
    await expect(store.write('x', data(5, 2))).rejects.toMatchObject({ code: 'failed' });
    (fsModule as { File: unknown }).File = RealFile;
    expect(await store.read('x')).toEqual(data(5, 1));
  });

  it('replaces a backup even where the platform refuses to move over an existing file', async () => {
    const fsModule = fakeExpoFileSystem(root);
    const RealFile = fsModule.File as never as new (...a: unknown[]) => { path: string; move(d: { path: string }, o?: object): Promise<void> };
    (fsModule as { File: unknown }).File = class extends RealFile {
      override async move(dest: { path: string }) {
        if (fs.existsSync(dest.path)) throw new Error('destination exists'); // ignores `overwrite`
        fs.renameSync(this.path, dest.path);
        this.path = dest.path;
      }
    };
    const store = createFileBackupStore({ load: async () => fsModule });
    await store.write('x', data(5, 1));
    await store.write('x', data(5, 2));
    expect(await store.read('x')).toEqual(data(5, 2));
    expect(fs.readdirSync(path.join(root, 'trikey-backups'))).toEqual(['x']); // no .tmp, no .old
  });

  it('is verified like every other provider', async () => {
    const backend = createFileBackend({ load: async () => fakeExpoFileSystem(root) });
    const store = createCloudBackupStore({
      ...backend,
      async put(name, bytes) {
        await backend.put(name, bytes);
        fs.appendFileSync(path.join(root, 'trikey-backups', name), 'x'); // corrupt after the write
      },
    });
    await expect(store.write('x', data(4))).rejects.toMatchObject({ code: 'verify-failed' });
  });

  it('is unavailable when expo-file-system cannot load (web)', async () => {
    const store = createFileBackupStore({
      load: async () => {
        throw new Error('expo-file-system is only available in an iOS or Android development build');
      },
    });
    expect(await store.isAvailable()).toBe(false);
    await expect(store.write('x', data(1))).rejects.toMatchObject({ code: 'unavailable' });
  });
});
