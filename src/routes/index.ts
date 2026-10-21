import { Router } from 'express';
import { health } from '../controllers/health.controller';
import { requireAllowedIp, requireAuth } from '../middlewares/auth.middleware';
import { authRoutes } from './auth.routes';
import { extractionRoutes } from './extraction.routes';
import { fileRoutes } from './file.routes';
import { runRoutes } from './run.routes';

/**
 * Every /api route. All of them check the IP allow-list;
 * everything except /auth/login also needs a session token.
 */
export const apiRoutes = Router();

apiRoutes.use(requireAllowedIp);
apiRoutes.use('/auth', authRoutes);

apiRoutes.use(requireAuth);
apiRoutes.get('/health', health);
apiRoutes.use('/extractions', extractionRoutes);
apiRoutes.use('/runs', runRoutes);
apiRoutes.use('/files', fileRoutes);
