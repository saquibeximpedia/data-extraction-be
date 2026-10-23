import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { getClientIp, isIpAllowed } from '../utils/client-ip';
import { forbidden, unauthorized } from '../utils/errors';

/**
 * Who called, set on res.locals.caller by requireAuth. Sign-in and accounts live in the web app;
 * this service only checks that a request carries a valid Supabase session.
 */
export interface Caller {
  id: string;
  email: string;
}

// Supabase verifies each token; the result is reused briefly so polling doesn't hit Auth every time
const CACHE_MS = 60_000;
const verified = new Map<string, { caller: Caller; at: number }>();

async function verify(token: string): Promise<Caller> {
  const hit = verified.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.caller;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw unauthorized('Your session has expired. Sign in again.');
  const caller: Caller = { id: data.user.id, email: data.user.email ?? '' };

  if (verified.size > 500) verified.clear();
  verified.set(token, { caller, at: Date.now() });
  return caller;
}

/** Rejects callers whose IP isn't in ALLOWED_IPS (applies to every /api route) */
export function requireAllowedIp(req: Request, _res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  if (!isIpAllowed(ip, env.allowedIpList)) {
    throw forbidden(`Your IP address (${ip}) is not in ALLOWED_IPS.`, { clientIp: ip });
  }
  next();
}

/** Requires a Supabase session: `Authorization: Bearer <access token>` */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw unauthorized();
  res.locals.caller = await verify(token);
  next();
}

export const currentCaller = (res: Response): Caller => res.locals.caller as Caller;
