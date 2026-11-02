// Looks for Google's closed or proprietary Android code in an APK: Google Play services, Firebase, ML Kit and the
// data transport they send through, and ML Kit's barcode model library. The Android build without Google code must
// have none of it, and CI fails that build if it does (.github/workflows/android-build.yml); for the standard build it
// only reports what is there.
//
// It looks at the dex files the way `unzip -p app.apk 'classes*.dex' | grep -a com/google/android/gms` would (any
// mention, a class the APK defines or one it only refers to), names the classes it finds, and also checks the native
// libraries, the files Google's libraries leave at the root of an APK and the manifest. No dependencies: the APK is read
// with Node's zlib.
//
//   node --import tsx apps/mobile/scripts/apk-google-scan.mts <app.apk> [--require-none]
//
// Exit code 1 with --require-none when anything is found, 2 when the APK cannot be read.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** Java packages (as dex writes them) of Google's closed libraries. */
export const FORBIDDEN_PACKAGES = ['com/google/android/gms/', 'com/google/firebase/', 'com/google/mlkit/', 'com/google/android/datatransport/'];

/** Files in an APK that come only with those libraries. */
export const FORBIDDEN_FILES: { what: string; pattern: RegExp }[] = [
  { what: "ML Kit's closed barcode scanner library", pattern: /(^|\/)libbarhopper[^/]*\.so$/ },
  { what: 'Google Play services, Firebase or data transport version file', pattern: /^(play-services-|firebase-|transport-)[^/]*\.properties$/ },
];

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

/** The entries of a zip file (an APK), from its central directory. */
export function zipEntries(zip: Buffer): ZipEntry[] {
  // The end of central directory record: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory entry ${i}`);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    entries.push({
      method: zip.readUInt16LE(p + 10),
      compressedSize: zip.readUInt32LE(p + 20),
      size: zip.readUInt32LE(p + 24),
      localHeaderOffset: zip.readUInt32LE(p + 42),
      name: zip.toString('utf8', p + 46, p + 46 + nameLength),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The uncompressed bytes of one entry. */
export function zipRead(zip: Buffer, e: ZipEntry): Buffer {
  const h = e.localHeaderOffset;
  if (zip.readUInt32LE(h) !== 0x04034b50) throw new Error(`bad local header for ${e.name}`);
  const start = h + 30 + zip.readUInt16LE(h + 26) + zip.readUInt16LE(h + 28);
  const raw = zip.subarray(start, start + e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`${e.name}: unsupported compression method ${e.method}`);
}

function uleb128(buf: Buffer, offset: number): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  let p = offset;
  for (;;) {
    const b = buf[p++]!;
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [value >>> 0, p];
    shift += 7;
  }
}

/** The type descriptors of a dex file (`Lcom/example/Foo;`), and which of them the file defines as classes. */
export function dexTypes(dex: Buffer): { defined: string[]; referenced: string[] } {
  if (dex.toString('latin1', 0, 4) !== 'dex\n') throw new Error('not a dex file');
  const stringIdsOff = dex.readUInt32LE(0x3c);
  const typeIdsSize = dex.readUInt32LE(0x40);
  const typeIdsOff = dex.readUInt32LE(0x44);
  const classDefsSize = dex.readUInt32LE(0x60);
  const classDefsOff = dex.readUInt32LE(0x64);
  const string = (idx: number) => {
    const dataOff = dex.readUInt32LE(stringIdsOff + idx * 4);
    const [, start] = uleb128(dex, dataOff); // length in UTF-16 units; the data ends at a 0 byte (MUTF-8)
    const end = dex.indexOf(0, start);
    return dex.toString('utf8', start, end);
  };
  const types: string[] = [];
  for (let i = 0; i < typeIdsSize; i++) types.push(string(dex.readUInt32LE(typeIdsOff + i * 4)));
  const defined: string[] = [];
  for (let i = 0; i < classDefsSize; i++) defined.push(types[dex.readUInt32LE(classDefsOff + i * 32)]!);
  return { defined, referenced: types };
}

export interface ScanReport {
  /** Classes of the forbidden packages that the APK contains, by package. */
  definedClasses: Record<string, string[]>;
  /** Types of those packages the APK's code mentions without containing them. */
  referencedOnly: Record<string, string[]>;
  /** Dex files in which the package names appear as bytes (what grep -a finds), by package. */
  mentions: Record<string, string[]>;
  /** Files of the forbidden kinds. */
  files: { name: string; what: string }[];
  /** The manifest names one of the packages (a Play services or Firebase component, a version meta-data). */
  manifest: string[];
  dexFiles: string[];
}

export function isClean(r: ScanReport): boolean {
  return (
    Object.keys(r.definedClasses).length === 0 &&
    Object.keys(r.referencedOnly).length === 0 &&
    Object.keys(r.mentions).length === 0 &&
    r.files.length === 0 &&
    r.manifest.length === 0
  );
}

const packageOf = (descriptor: string) => FORBIDDEN_PACKAGES.find((p) => descriptor.startsWith(`L${p}`));
const add = (map: Record<string, string[]>, key: string, value: string) => (map[key] ??= []).push(value);

export function scanApk(apk: Buffer): ScanReport {
  const entries = zipEntries(apk);
  const report: ScanReport = { definedClasses: {}, referencedOnly: {}, mentions: {}, files: [], manifest: [], dexFiles: [] };
  for (const e of entries) {
    for (const f of FORBIDDEN_FILES) if (f.pattern.test(e.name)) report.files.push({ name: e.name, what: f.what });
    if (/^classes\d*\.dex$/.test(e.name)) {
      report.dexFiles.push(e.name);
      const dex = zipRead(apk, e);
      for (const p of FORBIDDEN_PACKAGES) if (dex.includes(p, 0, 'latin1')) add(report.mentions, p, e.name);
      const { defined, referenced } = dexTypes(dex);
      const definedHere = new Set(defined);
      for (const d of defined) {
        const p = packageOf(d);
        if (p) add(report.definedClasses, p, d);
      }
      for (const t of referenced) {
        const p = packageOf(t);
        if (p && !definedHere.has(t)) add(report.referencedOnly, p, t);
      }
    }
    if (e.name === 'AndroidManifest.xml') {
      const xml = zipRead(apk, e);
      for (const p of FORBIDDEN_PACKAGES) {
        const dotted = p.replace(/\//g, '.').replace(/\.$/, '');
        if (xml.includes(Buffer.from(dotted, 'utf16le')) || xml.includes(Buffer.from(dotted, 'utf8'))) report.manifest.push(dotted);
      }
    }
  }
  // A type referenced in one dex file may be defined in another: only the ones no dex file defines count as references.
  const allDefined = new Set(Object.values(report.definedClasses).flat());
  for (const [p, list] of Object.entries(report.referencedOnly)) {
    const left = [...new Set(list.filter((t) => !allDefined.has(t)))].sort();
    if (left.length) report.referencedOnly[p] = left;
    else delete report.referencedOnly[p];
  }
  for (const list of Object.values(report.definedClasses)) list.sort();
  if (report.dexFiles.length === 0) throw new Error('no classes.dex in the APK');
  return report;
}

/** The report as lines of text: a summary per package with a few class names. */
export function formatReport(r: ScanReport, sample = 8): string[] {
  const lines: string[] = [];
  const list = (title: string, map: Record<string, string[]>) => {
    for (const [p, names] of Object.entries(map)) {
      lines.push(`${title} ${p}: ${names.length} (${names.slice(0, sample).join(', ')}${names.length > sample ? ', ...' : ''})`);
    }
  };
  list('Classes of', r.definedClasses);
  list('Referenced, not included, from', r.referencedOnly);
  for (const [p, dex] of Object.entries(r.mentions)) lines.push(`"${p}" appears in ${dex.join(', ')}`);
  for (const f of r.files) lines.push(`${f.what}: ${f.name}`);
  for (const m of r.manifest) lines.push(`The manifest names ${m}`);
  if (isClean(r)) lines.push(`No Google Play services, Firebase, ML Kit or data transport code (${r.dexFiles.length} dex files, every file and the manifest checked).`);
  return lines;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: apk-google-scan.mts <app.apk> [--require-none]');
    process.exit(2);
  }
  let report: ScanReport;
  try {
    report = scanApk(readFileSync(file));
  } catch (e) {
    console.error(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  for (const line of formatReport(report)) console.log(line);
  if (args.includes('--require-none') && !isClean(report)) process.exit(1);
}
