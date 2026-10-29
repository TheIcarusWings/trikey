/**
 * Stable error code table for the Trikey RPC protocol.
 *
 * Codes -32768..-32000 are the JSON-RPC 2.0 reserved range and keep their standard meaning.
 * Codes 1000..1999 are Trikey application errors. Existing codes never change meaning and are
 * never reused; new ones are only ever added.
 */
export const ErrorCode = {
  // JSON-RPC 2.0 standard
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // 10xx: identity and pairing
  Unauthorized: 1001,
  PairingRejected: 1002,
  AlreadyPaired: 1003,

  // 11xx: guardian state
  GuardianLocked: 1100,
  UnlockFailed: 1101,

  // 12xx: policy
  PolicyViolation: 1200,
  ApprovalRequired: 1201,
  ApprovalInvalid: 1202,
  ApprovalExpired: 1203,
  StaleSequence: 1204,

  // 13xx: recovery
  RecoveryNotFound: 1300,
  RecoveryAlreadyActive: 1301,
  RecoveryNotActive: 1302,

  // 14xx: PSBTs
  PsbtInvalid: 1400,
  PsbtRejected: 1401,

  // 15xx: operational
  RateLimited: 1500,
  Unavailable: 1501,
} as const;

export type ErrorCodeName = keyof typeof ErrorCode;
export type ErrorCodeValue = (typeof ErrorCode)[ErrorCodeName];

/** Default human-readable message for each code (a responder may send a more specific one). */
export const ErrorMessage: Record<ErrorCodeValue, string> = {
  [ErrorCode.ParseError]: 'Parse error',
  [ErrorCode.InvalidRequest]: 'Invalid request',
  [ErrorCode.MethodNotFound]: 'Method not found',
  [ErrorCode.InvalidParams]: 'Invalid params',
  [ErrorCode.InternalError]: 'Internal error',
  [ErrorCode.Unauthorized]: 'Unauthorized',
  [ErrorCode.PairingRejected]: 'Pairing rejected',
  [ErrorCode.AlreadyPaired]: 'Already paired',
  [ErrorCode.GuardianLocked]: 'Guardian is locked',
  [ErrorCode.UnlockFailed]: 'Unlock failed',
  [ErrorCode.PolicyViolation]: 'Request violates the policy',
  [ErrorCode.ApprovalRequired]: 'Hardware approval required',
  [ErrorCode.ApprovalInvalid]: 'Hardware approval is invalid',
  [ErrorCode.ApprovalExpired]: 'Hardware approval has expired',
  [ErrorCode.StaleSequence]: 'Stale policy sequence number',
  [ErrorCode.RecoveryNotFound]: 'Recovery not found',
  [ErrorCode.RecoveryAlreadyActive]: 'A recovery is already active',
  [ErrorCode.RecoveryNotActive]: 'Recovery is not active',
  [ErrorCode.PsbtInvalid]: 'Invalid PSBT',
  [ErrorCode.PsbtRejected]: 'PSBT rejected',
  [ErrorCode.RateLimited]: 'Rate limited',
  [ErrorCode.Unavailable]: 'Temporarily unavailable',
};

/** An error that crosses the wire: thrown by handlers, and by the client for error responses. */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message?: string, data?: unknown) {
    super(message ?? ErrorMessage[code as ErrorCodeValue] ?? `RPC error ${code}`);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  toJSON(): { code: number; message: string; data?: unknown } {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}
