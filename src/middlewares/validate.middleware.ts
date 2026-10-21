import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { badRequest } from '../utils/errors';

/** Parses data with a zod schema, throwing a 400 with field details on failure */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest('Validation failed', { details: z.flattenError(result.error).fieldErrors });
  return result.data;
}

/** Validates (and replaces) req.body before the controller runs */
export function validateBody(schema: z.ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = parse(schema, req.body ?? {});
    next();
  };
}
