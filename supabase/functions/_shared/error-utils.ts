/**
 * Shared Error Utilities for Edge Functions
 * 
 * Provides sanitized error handling to prevent leaking internal
 * implementation details to clients while preserving full details
 * in server-side logs.
 */

export interface SanitizedErrorResponse {
  success: false;
  errorCode: string;
  message: string;
}

/**
 * Error codes for categorizing errors without exposing internal details
 */
export const ErrorCodes = {
  // Authentication/Authorization
  AUTH_MISSING: 'AUTH_MISSING',
  AUTH_INVALID: 'AUTH_INVALID',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  AUTH_INSUFFICIENT: 'AUTH_INSUFFICIENT',
  
  // Rate limiting
  RATE_LIMITED: 'RATE_LIMITED',
  CREDITS_EXHAUSTED: 'CREDITS_EXHAUSTED',
  
  // External service errors
  EXTERNAL_SERVICE: 'EXTERNAL_SERVICE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  
  // Database errors
  DATABASE_ERROR: 'DATABASE_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  
  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MISSING_CONFIG: 'MISSING_CONFIG',
  
  // Generic errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * User-safe error messages that don't expose internal details
 */
const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCodes.AUTH_MISSING]: 'Authentication required',
  [ErrorCodes.AUTH_INVALID]: 'Invalid credentials',
  [ErrorCodes.AUTH_EXPIRED]: 'Session expired, please sign in again',
  [ErrorCodes.AUTH_INSUFFICIENT]: 'You do not have permission for this action',
  [ErrorCodes.RATE_LIMITED]: 'Too many requests, please try again later',
  [ErrorCodes.CREDITS_EXHAUSTED]: 'Service credits exhausted',
  [ErrorCodes.EXTERNAL_SERVICE]: 'External service temporarily unavailable',
  [ErrorCodes.SERVICE_UNAVAILABLE]: 'Service temporarily unavailable',
  [ErrorCodes.DATABASE_ERROR]: 'Unable to process request',
  [ErrorCodes.NOT_FOUND]: 'Requested resource not found',
  [ErrorCodes.VALIDATION_ERROR]: 'Invalid request data',
  [ErrorCodes.MISSING_CONFIG]: 'Service configuration incomplete',
  [ErrorCodes.INTERNAL_ERROR]: 'An error occurred processing your request',
  [ErrorCodes.UNKNOWN_ERROR]: 'An unexpected error occurred',
};

/**
 * Categorize an error and return a sanitized response
 * Logs full error details server-side for debugging
 */
export function sanitizeError(
  error: unknown,
  context: string,
  customMessage?: string
): { code: ErrorCode; response: SanitizedErrorResponse } {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  
  // Log full error details server-side
  console.error(`[${context}] Error:`, {
    message: errorMessage,
    stack: errorStack,
    timestamp: new Date().toISOString(),
  });
  
  // Categorize the error based on message patterns
  let code: ErrorCode = ErrorCodes.UNKNOWN_ERROR;
  
  // Check for common error patterns
  const lowerMessage = errorMessage.toLowerCase();
  
  if (lowerMessage.includes('not configured') || lowerMessage.includes('missing')) {
    code = ErrorCodes.MISSING_CONFIG;
  } else if (lowerMessage.includes('unauthorized') || lowerMessage.includes('auth')) {
    code = ErrorCodes.AUTH_INVALID;
  } else if (lowerMessage.includes('permission') || lowerMessage.includes('forbidden')) {
    code = ErrorCodes.AUTH_INSUFFICIENT;
  } else if (lowerMessage.includes('not found') || lowerMessage.includes('no rows')) {
    code = ErrorCodes.NOT_FOUND;
  } else if (lowerMessage.includes('rate limit') || lowerMessage.includes('429')) {
    code = ErrorCodes.RATE_LIMITED;
  } else if (lowerMessage.includes('timeout')) {
    code = ErrorCodes.SERVICE_UNAVAILABLE;
  } else if (lowerMessage.includes('database') || lowerMessage.includes('query') || lowerMessage.includes('sql')) {
    code = ErrorCodes.DATABASE_ERROR;
  } else if (lowerMessage.includes('api') || lowerMessage.includes('fetch') || lowerMessage.includes('request failed')) {
    code = ErrorCodes.EXTERNAL_SERVICE;
  } else if (lowerMessage.includes('invalid') || lowerMessage.includes('required')) {
    code = ErrorCodes.VALIDATION_ERROR;
  } else {
    code = ErrorCodes.INTERNAL_ERROR;
  }
  
  return {
    code,
    response: {
      success: false,
      errorCode: code,
      message: customMessage || ERROR_MESSAGES[code],
    },
  };
}

/**
 * Create a sanitized error response for HTTP responses
 */
export function createErrorResponse(
  error: unknown,
  context: string,
  corsHeaders: Record<string, string>,
  customMessage?: string,
  statusCode?: number
): Response {
  const { code, response } = sanitizeError(error, context, customMessage);
  
  // Determine appropriate HTTP status code
  let status = statusCode || 500;
  switch (code) {
    case ErrorCodes.AUTH_MISSING:
    case ErrorCodes.AUTH_INVALID:
    case ErrorCodes.AUTH_EXPIRED:
      status = 401;
      break;
    case ErrorCodes.AUTH_INSUFFICIENT:
      status = 403;
      break;
    case ErrorCodes.RATE_LIMITED:
      status = 429;
      break;
    case ErrorCodes.CREDITS_EXHAUSTED:
      status = 402;
      break;
    case ErrorCodes.NOT_FOUND:
      status = 404;
      break;
    case ErrorCodes.VALIDATION_ERROR:
      status = 400;
      break;
  }
  
  return new Response(
    JSON.stringify(response),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

/**
 * Sanitize external API error details
 * Use this when catching errors from third-party APIs
 */
export function sanitizeExternalApiError(
  context: string,
  serviceName: string,
  statusCode: number,
  _errorBody: string
): SanitizedErrorResponse {
  // Log full details server-side
  console.error(`[${context}] ${serviceName} API error:`, {
    statusCode,
    timestamp: new Date().toISOString(),
  });
  
  // Return generic message to client
  return {
    success: false,
    errorCode: ErrorCodes.EXTERNAL_SERVICE,
    message: `${serviceName} service temporarily unavailable`,
  };
}
