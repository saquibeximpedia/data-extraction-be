import { Request, Response } from 'express';
import { currentUser } from '../middlewares/auth.middleware';

/** GET /api/auth/me → the signed-in user and role (sign-in itself happens in the browser with Supabase) */
export function me(_req: Request, res: Response): void {
  res.json(currentUser(res));
}
