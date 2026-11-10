// Reads the pixel size of a PNG, JPEG, GIF, WebP or SVG file from its header, so blog images get width and height
// attributes (no layout shift while they load). No dependencies.
import { readFileSync } from 'node:fs';

/** Returns { width, height } or null if the format isn't recognised. */
export function imageSize(file) {
  const b = readFileSync(file);
  // PNG: IHDR is the first chunk.
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // GIF
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    return null;
  }
  // JPEG: walk the segments to a start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return null;
  }
  // SVG: width/height attributes in px (or unitless), else the viewBox.
  const text = b.toString('utf8', 0, Math.min(b.length, 4096));
  const svg = /<svg\b[^>]*>/i.exec(text);
  if (svg) {
    const attr = (name) => {
      const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i').exec(svg[0]);
      return m ? Math.round(parseFloat(m[1])) : null;
    };
    const w = attr('width');
    const h = attr('height');
    if (w && h) return { width: w, height: h };
    const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(svg[0]);
    if (vb) return { width: Math.round(parseFloat(vb[1])), height: Math.round(parseFloat(vb[2])) };
  }
  return null;
}
