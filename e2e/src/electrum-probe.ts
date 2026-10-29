/**
 * Asks an Electrum server (Electrs) for its tip over plain TCP, the way the guardian does at connect time: used to
 * wait until the index has caught up with the node. Independent of the guardian's own client on purpose.
 */
import { connect } from 'node:net';

export interface ElectrumProbe {
  /** `[software, protocol]` from `server.version`. */
  server: [string, string];
  height: number;
}

export function probeElectrum(host: string, port: number, timeoutMs = 5000): Promise<ElectrumProbe> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buf = '';
    let server: [string, string] | undefined;
    const done = (err: Error | undefined, value?: ElectrumProbe) => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => done(new Error(`no answer from Electrum at ${host}:${port} within ${timeoutMs} ms`)), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error', (e) => done(new Error(`Electrum at ${host}:${port} unreachable (${e.message})`)));
    socket.on('close', () => done(new Error(`Electrum at ${host}:${port} closed the connection`)));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server.version', params: ['trikey-e2e', '1.4'] })}\n`);
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'blockchain.headers.subscribe', params: [] })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: { id?: number; result?: unknown; error?: { message?: string } | string | null };
        try {
          msg = JSON.parse(line);
        } catch {
          return done(new Error('Electrum sent a line that is not JSON'));
        }
        if (msg.error) return done(new Error(`Electrum error: ${typeof msg.error === 'string' ? msg.error : msg.error.message}`));
        if (msg.id === 1) server = msg.result as [string, string];
        if (msg.id === 2) {
          const height = (msg.result as { height?: unknown } | undefined)?.height;
          if (typeof height !== 'number') return done(new Error('Electrum did not report a tip height'));
          return done(undefined, { server: server ?? ['unknown', 'unknown'], height });
        }
      }
    });
  });
}
