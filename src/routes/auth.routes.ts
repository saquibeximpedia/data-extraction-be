import { Router } from 'express';
import * as auth from '../controllers/auth.controller';

export const authRoutes = Router();

authRoutes.get('/me', auth.me);
