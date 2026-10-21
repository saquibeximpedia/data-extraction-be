import { NextFunction, Request, Response } from 'express';
import { HttpError } from '../utils/errors';

/** 404 for unknown /api routes */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl.split('?')[0]}` });
}

/** Turns thrown errors into JSON. HttpErrors keep their status; anything else is a 500. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...err.details });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Request body is not valid JSON' });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
