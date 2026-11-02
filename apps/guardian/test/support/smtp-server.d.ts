/** The few parts of smtp-server (a devDependency, no types of its own) the notification tests use. */
declare module 'smtp-server' {
  import type { Server } from 'node:net';
  import type { Readable } from 'node:stream';

  export interface SMTPServerAuthentication {
    method: string;
    username?: string;
    password?: string;
  }
  export interface SMTPServerSession {
    secure: boolean;
    envelope: { mailFrom: { address: string } | false; rcptTo: { address: string }[] };
  }
  export interface SMTPServerOptions {
    secure?: boolean;
    /** The server's TLS key and certificate (PEM); default: smtp-server's built-in test certificate. */
    key?: string | Buffer;
    cert?: string | Buffer;
    hideSTARTTLS?: boolean;
    authOptional?: boolean;
    disabledCommands?: string[];
    logger?: boolean;
    onAuth?(auth: SMTPServerAuthentication, session: SMTPServerSession, cb: (err: Error | null, res?: { user: string }) => void): void;
    onData?(stream: Readable, session: SMTPServerSession, cb: (err?: Error | null) => void): void;
  }
  export class SMTPServer {
    constructor(opts: SMTPServerOptions);
    server: Server;
    listen(port: number, host: string, cb?: () => void): Server;
    close(cb?: () => void): void;
    on(event: 'error', listener: (err: Error) => void): this;
  }
}
