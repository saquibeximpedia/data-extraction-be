import { Request, Response } from 'express';
import { env } from '../config/env';
import { authService } from '../services/auth.service';
import { getClientIp } from '../utils/client-ip';
import { forbidden } from '../utils/errors';

/** POST /api/auth/login { password } → session token */
export function login(req: Request, res: Response): void {
  if (!authService.checkPassword(req.body.password)) throw forbidden('Wrong password');
  res.json({ token: authService.issueToken(getClientIp(req)), expiresIn: env.TOKEN_EXPIRY });
}

/** GET /api/auth/session → 200 while the token is valid (requireAuth does the check) */
export function session(_req: Request, res: Response): void {
  res.json({ valid: true, session: res.locals.session });
}
