import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { authService } from '../services/auth.service';
import { getClientIp, isIpAllowed } from '../utils/client-ip';
import { forbidden, unauthorized } from '../utils/errors';

/** Rejects callers whose IP isn't in ALLOWED_IPS (applies to every /api route) */
export function requireAllowedIp(req: Request, _res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  if (!isIpAllowed(ip, env.allowedIpList)) {
    throw forbidden(`Your IP address (${ip}) is not in ALLOWED_IPS.`, { clientIp: ip });
  }
  next();
}

/**
 * Requires a valid session token: `Authorization: Bearer <token>`,
 * or `?token=` for plain links such as file downloads.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : typeof req.query.token === 'string' ? req.query.token : undefined;
  if (!token) throw unauthorized();

  try {
    res.locals.session = authService.verifyToken(token);
  } catch (err: any) {
    throw unauthorized(err.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid session token');
  }
  next();
}
