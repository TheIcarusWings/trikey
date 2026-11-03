// The check CI runs on the APK of the Android build without Google code (scripts/apk-google-scan.mts), on APKs built
// here byte by byte: a zip with dex files that define or mention classes, native libraries and a manifest.
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { dexTypes, formatReport, isClean, scanApk, zipEntries, zipRead } from '../scripts/apk-google-scan.mjs';

/** A zip file: entries stored, or deflated when `deflate` is set (as an APK keeps its dex files). */
function zip(files: Record<string, Buffer | string>, deflate: string[] = []): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = deflate.includes(name) ? deflateRawSync(data) : data;
    const method = deflate.includes(name) ? 8 : 0;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** A dex file that defines `classes` and refers to `referenced` (type descriptors), and holds `strings`. */
function dex(classes: string[], referenced: string[] = [], strings: string[] = []): Buffer {
  const types = [...new Set([...classes, ...referenced])];
  const allStrings = [...new Set([...types, ...strings])].sort();
  const headerSize = 0x70;
  const stringIdsOff = headerSize;
  const typeIdsOff = stringIdsOff + allStrings.length * 4;
  const classDefsOff = typeIdsOff + types.length * 4;
  let dataOff = classDefsOff + classes.length * 32;
  const parts: Buffer[] = [];
  const stringOffsets: number[] = [];
  for (const s of allStrings) {
    const bytes = Buffer.from(s, 'utf8');
    if (bytes.length > 127) throw new Error('test dex: keep strings short');
    stringOffsets.push(dataOff);
    const item = Buffer.concat([Buffer.from([bytes.length]), bytes, Buffer.from([0])]);
    parts.push(item);
    dataOff += item.length;
  }
  const head = Buffer.alloc(classDefsOff + classes.length * 32);
  head.write('dex\n035\0', 0, 'latin1');
  head.writeUInt32LE(allStrings.length, 0x38);
  head.writeUInt32LE(stringIdsOff, 0x3c);
  head.writeUInt32LE(types.length, 0x40);
  head.writeUInt32LE(typeIdsOff, 0x44);
  head.writeUInt32LE(classes.length, 0x60);
  head.writeUInt32LE(classDefsOff, 0x64);
  stringOffsets.forEach((off, i) => head.writeUInt32LE(off, stringIdsOff + i * 4));
  types.forEach((t, i) => head.writeUInt32LE(allStrings.indexOf(t), typeIdsOff + i * 4));
  classes.forEach((c, i) => head.writeUInt32LE(types.indexOf(c), classDefsOff + i * 32));
  return Buffer.concat([head, ...parts]);
}

const APP = ['Lapp/trikey/wallet/MainActivity;', 'Lapp/trikey/qrcamera/QrDecoder;', 'Lzxingcpp/BarcodeReader;', 'Landroidx/credentials/CredentialManager;'];

describe('reading an APK', () => {
  it('reads stored and deflated entries and the classes a dex file defines and mentions', () => {
    const d = dex(['La/B;'], ['Lc/D;']);
    const apk = zip({ 'classes.dex': d, 'res/raw/x.txt': 'hello' }, ['classes.dex']);
    const entries = zipEntries(apk);
    expect(entries.map((e) => [e.name, e.method])).toEqual([
      ['classes.dex', 8],
      ['res/raw/x.txt', 0],
    ]);
    expect(zipRead(apk, entries[0]!)).toEqual(d);
    expect(zipRead(apk, entries[1]!).toString()).toBe('hello');
    expect(dexTypes(d)).toEqual({ defined: ['La/B;'], referenced: ['La/B;', 'Lc/D;'] });
  });

  it('refuses what is not an APK', () => {
    expect(() => scanApk(Buffer.from('not a zip'))).toThrow(/not a zip/);
    expect(() => scanApk(zip({ 'res/x': 'y' }))).toThrow(/no classes\.dex/);
  });
});

describe('the scan', () => {
  it('passes an APK with no Google code (zxing-cpp, androidx.credentials are fine)', () => {
    const apk = zip({ 'AndroidManifest.xml': Buffer.from('app.trikey.wallet android.permission.CAMERA', 'utf16le'), 'classes.dex': dex(APP), 'classes2.dex': dex(['Lexpo/modules/Foo;']), 'lib/arm64-v8a/libzxingcpp_android.so': 'ELF' }, ['classes.dex']);
    const r = scanApk(apk);
    expect(isClean(r)).toBe(true);
    expect(r.dexFiles).toEqual(['classes.dex', 'classes2.dex']);
    expect(formatReport(r)).toEqual([expect.stringMatching(/^No Google Play services, Firebase, ML Kit or data transport code \(2 dex files/)]);
  });

  it('finds the classes of the 0.1.8 APK: Play services auth and FIDO, Firebase, ML Kit, data transport', () => {
    const google = [
      'Lcom/google/android/gms/auth/api/signin/GoogleSignInClient;',
      'Lcom/google/android/gms/fido/fido2/Fido2ApiClient;',
      'Lcom/google/firebase/components/ComponentDiscoveryService;',
      'Lcom/google/mlkit/vision/barcode/BarcodeScanning;',
      'Lcom/google/android/datatransport/runtime/TransportRuntime;',
    ];
    const apk = zip({
      'AndroidManifest.xml': Buffer.from('com.google.android.gms.version com.google.firebase.components.ComponentDiscoveryService', 'utf16le'),
      'classes.dex': dex(APP),
      'classes3.dex': dex(google),
      'lib/arm64-v8a/libbarhopper_v3.so': 'ELF',
      'play-services-basement.properties': 'version=18',
      'firebase-components.properties': 'version=18',
      'transport-runtime.properties': 'version=3',
    });
    const r = scanApk(apk);
    expect(isClean(r)).toBe(false);
    expect(Object.keys(r.definedClasses).sort()).toEqual(['com/google/android/datatransport/', 'com/google/android/gms/', 'com/google/firebase/', 'com/google/mlkit/']);
    expect(r.definedClasses['com/google/android/gms/']).toHaveLength(2);
    expect(r.files.map((f) => f.name)).toEqual(['lib/arm64-v8a/libbarhopper_v3.so', 'play-services-basement.properties', 'firebase-components.properties', 'transport-runtime.properties']);
    expect(r.manifest).toEqual(['com.google.android.gms', 'com.google.firebase']);
    expect(formatReport(r).join('\n')).toMatch(/Classes of com\/google\/mlkit\/: 1 \(Lcom\/google\/mlkit\/vision\/barcode\/BarcodeScanning;\)/);
  });

  it('also fails on code that only refers to those classes (expo-camera with its scanner switched off)', () => {
    const r = scanApk(zip({ 'classes.dex': dex(['Lexpo/modules/camera/analyzers/BarcodeAnalyzer;'], ['Lcom/google/mlkit/vision/barcode/common/Barcode;']) }));
    expect(r.definedClasses).toEqual({});
    expect(r.referencedOnly).toEqual({ 'com/google/mlkit/': ['Lcom/google/mlkit/vision/barcode/common/Barcode;'] });
    expect(r.mentions).toEqual({ 'com/google/mlkit/': ['classes.dex'] });
    expect(isClean(r)).toBe(false);
  });

  it('a class defined in one dex file and used in another counts once, as included', () => {
    const gms = 'Lcom/google/android/gms/common/GoogleApiAvailability;';
    const r = scanApk(zip({ 'classes.dex': dex(['La/B;'], [gms]), 'classes2.dex': dex([gms]) }));
    expect(r.definedClasses).toEqual({ 'com/google/android/gms/': [gms] });
    expect(r.referencedOnly).toEqual({});
  });

  it('finds the package name anywhere in a dex file, as grep -a does (a string, not a type)', () => {
    const r = scanApk(zip({ 'classes.dex': dex(['La/B;'], [], ['com/google/firebase/installations']) }));
    expect(r.mentions).toEqual({ 'com/google/firebase/': ['classes.dex'] });
    expect(isClean(r)).toBe(false);
  });

  it('is not fooled by look-alike names', () => {
    const r = scanApk(zip({ 'classes.dex': dex(['Lcom/google/common/collect/ImmutableList;', 'Lcom/google/zxing/Reader;', 'Lcom/googlex/android/gms/X;']), 'lib/arm64-v8a/libbarcode.so': 'x', 'assets/firebase.json': '{}' }));
    expect(isClean(r)).toBe(true);
  });
});
