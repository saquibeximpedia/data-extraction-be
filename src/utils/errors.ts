/**
 * An error with an HTTP status. Throw it from a service or controller and the
 * error middleware turns it into `{ error, ...details }` with that status.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) => new HttpError(400, message, details);
export const unauthorized = (message = 'Sign in required') => new HttpError(401, message);
export const forbidden = (message: string, details?: Record<string, unknown>) => new HttpError(403, message, details);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
