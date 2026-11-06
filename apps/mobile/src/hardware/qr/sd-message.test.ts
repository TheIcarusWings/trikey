/**
 * microSD message signing (sd-message.ts): the request file each firmware reads, and the signed file it writes back.
 *
 * The request files are checked against small ports of each firmware's own parser (the lines Trikey relies on, read
 * from the sources sd-message.ts names): Passport gen 2's `HealthCheckCommonFlow.validate_lines` and Krux's
 * `_sign_at_address_from_sd`. The answers are the files each firmware writes (Passport's RFC template with a trailing
 * newline and a numbered `-signed-001` name; Krux's armored block without one, `-signed.txt`), and the wrong files an
 * owner may pick.
 */
import { describe, expect, it } from 'vitest';
import { MIN_QR_MESSAGE_LIMIT, QR_MODEL_INFO, messageProblemFor, qrMessageMethod, qrModelUnlocks, verifyBip137Message } from '@trikey/wallet';
import { hwSigner } from '../../../../../packages/core/test/helpers';
import { signMessage as signBip137 } from '../../../../../packages/wallet/src/bip137';
import { network } from '../test/fixtures';
import { checkMessageAnswer, messageAddresses } from './message';
import { MAX_SIGNED_FILE_BYTES, PASSPORT_MAX_FILE_BYTES, baseName, parseSignedFile, sdFormatOf, sdRequestFile } from './sd-message';

const AUTH = "m/48'/1'/0'/2'/0/0";
const TEXT = `Trikey pair v1 wallet=0123456789abcdef guardian=03${'ab'.repeat(32)}`;
const key = () => hwSigner().master(network).derive(AUTH);
const sign = (text: string, priv = key().privateKey!) => signBip137(text, priv);
const legacy = () => messageAddresses(key().publicKey!, 'regtest').p2pkh;
const file = (name: string, text: string) => ({ name, bytes: new TextEncoder().encode(text) });

/** Passport gen 2, `health_check_common_flow.py` `validate_lines` (normal signing), and `utils.validate_sign_text`. */
function passportReads(data: string): { text: string; subpath: string; addrType: 'classic' | string } | string {
  if (new TextEncoder().encode(data).length > 4096) return 'Message file is too long.';
  const lines = data.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop(); // str.splitlines drops the empty piece after a final newline
  const header = lines[0]?.split(' ') ?? [];
  if (data.startsWith('signmessage ') && (lines.length === 1 || header[2]?.startsWith('ascii:'))) return 'electrum format: address type from the path (P2WSH: fails)';
  if (lines.length !== 2 && lines.length !== 3) return 'format is invalid';
  const [text, subpath] = [lines[0]!, lines[1]!];
  if (!text) return 'Message is empty.';
  if (text[0] === ' ' || text.at(-1) === ' ') return 'whitespace';
  let run = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126) return 'non-ASCII';
    run = ch === ' ' ? run + 1 : 0;
    if (run >= 4) return 'spaces';
  }
  if (!subpath.startsWith('m') || !/^(m|m\/|)[0-9/']*$/.test(subpath.toLowerCase().replace(/[ph]/g, "'"))) return 'bad path';
  return { text, subpath, addrType: lines.length === 3 ? lines[2]! : 'classic' };
}

/** Krux, `sign_message_ui.py` `_sign_at_address_from_sd` and `_is_valid_derivation_path`. */
function kruxReads(data: string): { message: string; path: string; type: string } | null {
  const lines = data
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l);
  if (lines.length === 0) return null;
  const type = lines.at(-1)!.toLowerCase();
  if (lines.length < 2 || !['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr'].includes(type)) return null;
  const path = lines.at(-2)!;
  const parts = path.split('/');
  if (parts[0] !== 'm' || !parts.slice(1).every((p) => p && (/^\d+['hH]$/.test(p) || /^\d+$/.test(p)))) return null;
  return { message: lines.slice(0, -2).join('\n'), path, type };
}

describe('the request file', () => {
  it('Passport gen 2: two lines, the text then the path with h steps; it reads them with the legacy address type', () => {
    const f = sdRequestFile('passport', AUTH, TEXT, { purpose: 'pairing' });
    expect(f).toEqual({ name: 'trikey-pair.txt', text: `${TEXT}\nm/48h/1h/0h/2h/0/0\n` });
    expect(passportReads(f.text)).toEqual({ text: TEXT, subpath: 'm/48h/1h/0h/2h/0/0', addrType: 'classic' });
    // Its file list hides names with -signed; its save flow needs an extension.
    expect(f.name).not.toMatch(/-signed/);
    expect(f.name).toMatch(/^[a-z0-9-]+\.txt$/);
  });

  it('Krux: three lines, the text, the path and p2pkh; it reads them as the text at that path', () => {
    const f = sdRequestFile('krux', "m/48'/0'/3'/2'/0/0", TEXT, { purpose: 'approval' });
    expect(f).toEqual({ name: 'trikey-approve.txt', text: `${TEXT}\nm/48h/0h/3h/2h/0/0\np2pkh\n` });
    expect(kruxReads(f.text)).toEqual({ message: TEXT, path: 'm/48h/0h/3h/2h/0/0', type: 'p2pkh' });
  });

  it('names say what it is for and, when signed twice, which round', () => {
    const name = (purpose?: string, round?: { n: number; of: number }) => sdRequestFile('passport', AUTH, TEXT, { ...(purpose ? { purpose } : {}), ...(round ? { round } : {}) }).name;
    expect([name('pairing'), name('rules'), name('approval'), name('recovery-access'), name('notes', { n: 2, of: 2 }), name('unlock'), name(), name('notes', { n: 1, of: 1 })]).toEqual([
      'trikey-pair.txt',
      'trikey-rules.txt',
      'trikey-approve.txt',
      'trikey-access.txt',
      'trikey-notes-2of2.txt',
      'trikey-unlock.txt',
      'trikey-sign.txt',
      'trikey-notes.txt',
    ]);
    expect(baseName('trikey-notes-2of2.txt')).toBe('trikey-notes-2of2');
  });

  it('refuses a text a firmware would change, read another way, or refuse', () => {
    expect(() => sdRequestFile('krux', AUTH, ` ${TEXT}`)).toThrow(/starts or ends with a space/);
    expect(() => sdRequestFile('passport', AUTH, 'two\nlines')).toThrow(/printable ASCII on one line/);
    expect(() => sdRequestFile('passport', AUTH, 'signmessage m/0 ascii:x')).toThrow(/cannot be signed/);
    expect(() => sdRequestFile('passport', AUTH, 'a'.repeat(PASSPORT_MAX_FILE_BYTES))).toThrow(/4096 bytes/);
    // A text at Passport's table limit still fits its 4096-byte file with any path.
    const at = sdRequestFile('passport', "m/48'/1'/2147483647'/2'/0/0", 'a'.repeat(QR_MODEL_INFO.passport.maxMessageLength!));
    expect(new TextEncoder().encode(at.text).length).toBeLessThanOrEqual(PASSPORT_MAX_FILE_BYTES);
    expect(typeof passportReads(at.text)).toBe('object');
  });

  it('the table: both sign from a microSD card, neither unlocks the guardian; the formats are known', () => {
    for (const model of ['passport', 'krux'] as const) {
      expect(qrMessageMethod(model)).toBe('microsd');
      expect(qrModelUnlocks(model)).toBe(false);
      expect(sdFormatOf(model)).toBe(model);
      expect(QR_MODEL_INFO[model].unlockWhyNot).toMatch(/microSD card.*passphrase/);
    }
    expect(QR_MODEL_INFO.krux.answersByQr).toBe(true);
    expect(QR_MODEL_INFO.passport.answersByQr).toBeUndefined();
    expect(sdFormatOf('jade')).toBeUndefined();
    expect(qrMessageMethod('jade')).toBe('qr-text');
    expect(qrModelUnlocks('jade')).toBe(true);
    expect([qrMessageMethod('seedsigner'), qrMessageMethod('other'), qrMessageMethod('coldcard-mk4')]).toEqual(['none', 'none', 'none']);
    expect(MIN_QR_MESSAGE_LIMIT).toBe(240);
    expect(messageProblemFor('passport', 'a   b')).toBeUndefined();
    expect(messageProblemFor('passport', 'a    b')).toMatch(/more than 3 spaces/);
  });
});

describe('the signed file', () => {
  const request = sdRequestFile('passport', AUTH, TEXT, { purpose: 'pairing' });
  const expected = () => ({ text: TEXT, pubkey: key().publicKey!, network: 'regtest' as const, path: AUTH, label: 'Passport', via: 'file' as const });
  const armored = (text: string, address: string, sig: string, end = '\n') =>
    `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${text}\n-----BEGIN BITCOIN SIGNATURE-----\n${address}\n${sig}\n-----END BITCOIN SIGNATURE-----${end}`;

  it("reads Passport's and Krux's armored files (LF or CRLF), and a bare signature; the signature verifies", () => {
    for (const text of [armored(TEXT, legacy(), sign(TEXT)), armored(TEXT, legacy(), sign(TEXT), ''), armored(TEXT, legacy(), sign(TEXT)).replace(/\n/g, '\r\n'), sign(TEXT)]) {
      const answer = parseSignedFile(file('trikey-pair-signed-001.txt', text), request, 'Passport');
      const sig = checkMessageAnswer(answer, expected());
      expect(verifyBip137Message(TEXT, key().publicKey!, sig)).toBe(true);
    }
    expect(parseSignedFile(file('x-signed.txt', armored(TEXT, legacy(), sign(TEXT))), request, 'Krux')).toEqual({ signature: sign(TEXT), address: legacy(), message: TEXT });
  });

  it('wrong key, wrong account or path, altered text: refused with words that say which', () => {
    const otherPath = hwSigner().master(network).derive("m/48'/1'/1'/2'/0/0");
    const otherAddress = messageAddresses(otherPath.publicKey!, 'regtest').p2pkh;
    const check = (text: string) => () => checkMessageAnswer(parseSignedFile(file('trikey-pair-signed-001.txt', text), request, 'Passport'), expected());
    expect(check(armored(TEXT, otherAddress, sign(TEXT, otherPath.privateKey!)))).toThrow(/signed with another key \(address \w+, not \w+\)/);
    expect(check(armored(TEXT, legacy(), sign(TEXT, new Uint8Array(32).fill(7))))).toThrow(/not from this wallet.s key .*pick the new signed file/);
    expect(check(armored(`${TEXT} limit=1`, legacy(), sign(`${TEXT} limit=1`)))).toThrow(/different text from the one Trikey asked for/);
    // The text changed after signing: the signature no longer matches it.
    expect(check(armored(TEXT.replace('pair', 'Pair'), legacy(), sign(TEXT)))).toThrow(/different text/);
    expect(check(sign(`${TEXT}!`))).toThrow(/not from this wallet.s key/);
  });

  it('garbage and the wrong kind of file: refused before any signature is looked at', () => {
    const read = (name: string, bytes: Uint8Array) => () => parseSignedFile({ name, bytes }, request, 'Krux');
    const text = (name: string, t: string) => read(name, new TextEncoder().encode(t));
    expect(text('trikey-pair.txt', request.text)).toThrow(/the file Trikey made \(the request\)/);
    expect(text('trikey-pair.txt', request.text.replace(/\n/g, '\r\n'))).toThrow(/the request/);
    expect(read('trikey-pair-signed.sig', new Uint8Array([0x30, 0x44, 2]))).toThrow(/\.sig file: your Krux signed the file.s hash/);
    expect(text('pubkey.pub', '02'.padEnd(66, 'a'))).toThrow(/public key file/);
    expect(text('notes.txt', 'hello')).toThrow(/That file is not a signed message\./);
    expect(text('half.txt', '-----BEGIN BITCOIN SIGNED MESSAGE-----\nTrikey')).toThrow(/incomplete/);
    expect(read('photo.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0x80]))).toThrow(/not text/);
    expect(read('empty.txt', new Uint8Array())).toThrow(/empty/);
    expect(read('big.txt', new Uint8Array(MAX_SIGNED_FILE_BYTES + 1).fill(65))).toThrow(/too large/);
    // An uncompressed-key header is refused, as over QR.
    const raw = Uint8Array.from(Buffer.from(sign(TEXT), 'base64'));
    raw[0] = 27;
    expect(text('x-signed.txt', Buffer.from(raw).toString('base64'))).toThrow(/uncompressed key/);
  });

  it('the other round’s signed file is refused by its name; this round’s is taken', () => {
    const r2 = sdRequestFile('krux', AUTH, TEXT, { purpose: 'notes', round: { n: 2, of: 2 } });
    const signed = armored(TEXT, legacy(), sign(TEXT), '');
    expect(() => parseSignedFile(file('trikey-notes-1of2-signed.txt', signed), r2, 'Krux', { n: 2, of: 2 })).toThrow(/other round.*round 2 of 2: sign trikey-notes-2of2.txt/);
    expect(parseSignedFile(file('trikey-notes-2of2-signed.txt', signed), r2, 'Krux', { n: 2, of: 2 }).signature).toBe(sign(TEXT));
  });
});
