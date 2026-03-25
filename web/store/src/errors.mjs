/**
 * HTTP-aware application error.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(status, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Build a normalized error payload from unknown input.
 *
 * @param {unknown} error
 * @returns {{ status: number, message: string, details: unknown }}
 */
export function toHttpError(error) {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      message: error.message,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return {
      status: 500,
      message: error.message,
      details: null,
    };
  }
  return {
    status: 500,
    message: String(error),
    details: null,
  };
}
