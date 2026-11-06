/**
 * Splits a stream of bytes into 64-byte reports (a Bluetooth notification may carry one report or several). In a file
 * of its own so link.ts and link.native.ts can both import it: from link.native.ts, './link' resolves to link.native.ts
 * itself on a phone (a self-import: the 0.1.18 iPhone crash).
 */
export class ReportSplitter {
  private pending = new Uint8Array(0);

  push(bytes: Uint8Array, emit: (report: Uint8Array) => void): void {
    const all = new Uint8Array(this.pending.length + bytes.length);
    all.set(this.pending);
    all.set(bytes, this.pending.length);
    let at = 0;
    for (; at + 64 <= all.length; at += 64) emit(all.slice(at, at + 64));
    this.pending = all.slice(at);
  }
}
