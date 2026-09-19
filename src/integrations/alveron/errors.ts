export class AppError extends Error {
  constructor(public readonly code: string, public readonly httpStatus?: number) {
    super(code);
    this.name = 'AppError';
  }
}

export function safeCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'INTERNAL_ERROR';
}

/** Phase 5 failure categories. Additive: existing Phase 4 error codes are unchanged. */
export type FailureCategory =
  | 'CONFIGURATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'RATE_LIMITED'
  | 'ALVERON_SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'VALIDATION_FAILED'
  | 'LEDGER_ERROR'
  | 'UNKNOWN_ERROR';

/**
 * Maps an internal error to an explicit category so n8n can distinguish transient from permanent
 * failures without parsing messages. Never returns the raw error text.
 */
export function classifyFailure(error: unknown): FailureCategory {
  if (!(error instanceof AppError)) return 'UNKNOWN_ERROR';
  const { code, httpStatus } = error;
  if (code.startsWith('CONFIG_')) return 'CONFIGURATION_ERROR';
  if (code === 'AUTHENTICATION_FAILED') return 'AUTHENTICATION_ERROR';
  if (code === 'AUTHORIZATION_ERROR') return 'AUTHORIZATION_ERROR';
  if (code === 'RATE_LIMITED') return 'RATE_LIMITED';
  if (code === 'NETWORK_ERROR') return 'NETWORK_ERROR';
  if (code === 'INVALID_RESPONSE') return 'INVALID_RESPONSE';
  if (code === 'LEDGER_FAILURE') return 'LEDGER_ERROR';
  if (code === 'VALIDATION_FAILED') return 'VALIDATION_FAILED';
  if (httpStatus === 401) return 'AUTHENTICATION_ERROR';
  if (httpStatus === 403) return 'AUTHORIZATION_ERROR';
  if (httpStatus === 429) return 'RATE_LIMITED';
  if (httpStatus !== undefined && httpStatus >= 500) return 'ALVERON_SERVER_ERROR';
  if (httpStatus !== undefined && httpStatus >= 400) return 'VALIDATION_FAILED';
  return 'UNKNOWN_ERROR';
}
