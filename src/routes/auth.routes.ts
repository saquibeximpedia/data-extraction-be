import { Router } from 'express';
import * as auth from '../controllers/auth.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { loginSchema } from '../schemas';

export const authRoutes = Router();

authRoutes.post('/login', validateBody(loginSchema), auth.login);
authRoutes.get('/session', requireAuth, auth.session);
