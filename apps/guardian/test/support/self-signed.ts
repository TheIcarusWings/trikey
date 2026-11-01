/**
 * Throwaway self-signed TLS certificates, made at test time (nothing is committed: no private key in the repository).
 * A minimal X.509 v3 certificate with an ECDSA P-256 key, written in DER by hand (Node can sign but not build
 * certificates): the subject is also the issuer, valid from a day ago for 30 days, with a subject alternative name for
 * 127.0.0.1 and `localhost`, like the certificate Proton Mail Bridge and small self-hosted relays make for themselves.
 */
import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...c: Buffer[]) => tlv(0x30, ...c);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const out = [40 * a + b];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let v = arc >>> 7; v > 0; v >>>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(ms: number): Buffer {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, 'ascii'));
}

const name = (cn: string) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));

export interface TestCert {
  /** The certificate, PEM. */
  cert: string;
  /** Its private key, PKCS#8 PEM (in memory only). */
  key: string;
  /** SHA-256 of the certificate, as Node and `openssl x509 -fingerprint -sha256` write it (`AB:CD:...`). */
  fingerprint256: string;
}

/**
 * A fresh self-signed certificate for `cn` (default `127.0.0.1`). `ca: false` makes it an end-entity certificate;
 * `expired` makes one that ran out a month ago.
 */
export function selfSignedCert(opts: { cn?: string; ca?: boolean; expired?: boolean } = {}): TestCert {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Date.now();
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const subject = name(opts.cn ?? '127.0.0.1');
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40; // a positive INTEGER in its shortest form (no leading zero byte)
  const basic = seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(...(opts.ca === false ? [] : [tlv(0x01, Buffer.from([0xff]))]))));
  const san = seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x87, Buffer.from([127, 0, 0, 1])), tlv(0x82, Buffer.from('localhost', 'ascii')))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, serial),
    ecdsaSha256,
    subject,
    opts.expired ? seq(utcTime(now - 60 * 86_400_000), utcTime(now - 30 * 86_400_000)) : seq(utcTime(now - 86_400_000), utcTime(now + 30 * 86_400_000)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(basic, san)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.from([0]), signature));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, fingerprint256: new X509Certificate(cert).fingerprint256 };
}
