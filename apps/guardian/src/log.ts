/**
 * One line per event, no secrets.
 *
 * Callers pass an event name and a few plain fields. Nothing here ever sees a
 * passphrase, a request body, a key or a PSBT: the HTTP layer never logs
 * bodies, and the fields below are filtered as a second line of defence.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** Field names that must never reach a log line, whatever a caller passes. */
const FORBIDDEN = /pass|secret|seed|mnemonic|priv|key|psbt|token|auth|cookie/i;
const MAX_VALUE = 200;

function render(level: LogLevel, event: string, fields: LogFields | undefined, now: Date): string {
  const parts = [now.toISOString(), level.toUpperCase(), event];
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === undefined) continue;
    if (FORBIDDEN.test(k) && k !== 'pubkey' && !k.endsWith('Pubkey')) {
      parts.push(`${k}=[redacted]`);
      continue;
    }
    let s = String(v).replace(/[\r\n\t]+/g, ' ');
    if (s.length > MAX_VALUE) s = `${s.slice(0, MAX_VALUE)}…`;
    parts.push(/[\s"=]/.test(s) || s === '' ? `${k}=${JSON.stringify(s)}` : `${k}=${s}`);
  }
  return parts.join(' ');
}

export function createLogger(opts: { level?: LogLevel; write?: (line: string) => void; now?: () => Date } = {}): Logger {
  const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const min = order.indexOf(opts.level ?? 'info');
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = opts.now ?? (() => new Date());
  const at = (level: LogLevel) => (event: string, fields?: LogFields) => {
    if (order.indexOf(level) >= min) write(render(level, event, fields, now()));
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A short, log-safe description of an error (message only, no stack, no data). */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
