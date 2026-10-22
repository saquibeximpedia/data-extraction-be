import { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { Role, roleOf, supabase } from '../config/supabase';
import { getClientIp, isIpAllowed } from '../utils/client-ip';
import { forbidden, unauthorized } from '../utils/errors';

/** The signed-in user, set on res.locals.user by requireAuth */
export interface SessionUser {
  id: string;
  email: string;
  role: Role;
}

// Supabase verifies each token; the result is reused briefly so polling doesn't hit Auth every time
const CACHE_MS = 60_000;
const verified = new Map<string, { user: SessionUser; at: number }>();

async function verify(token: string): Promise<SessionUser> {
  const hit = verified.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw unauthorized('Your session has expired. Sign in again.');
  const user: SessionUser = { id: data.user.id, email: data.user.email ?? '', role: roleOf(data.user) };

  if (verified.size > 500) verified.clear();
  verified.set(token, { user, at: Date.now() });
  return user;
}

/** Forgets cached sessions of a user, e.g. after their account is deleted or their role changes */
export function forgetUser(userId: string): void {
  for (const [token, entry] of verified) if (entry.user.id === userId) verified.delete(token);
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
  res.locals.user = await verify(token);
  next();
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction): void {
  if ((res.locals.user as SessionUser | undefined)?.role !== 'admin') throw forbidden('Only admins can do this.');
  next();
}

export const currentUser = (res: Response): SessionUser => res.locals.user as SessionUser;
