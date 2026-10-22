import { Router } from 'express';
import { health } from '../controllers/health.controller';
import { requireAllowedIp, requireAuth } from '../middlewares/auth.middleware';
import { adminRoutes } from './admin.routes';
import { authRoutes } from './auth.routes';
import { countryRoutes } from './country.routes';
import { extractionRoutes } from './extraction.routes';
import { fileRoutes } from './file.routes';
import { runRoutes } from './run.routes';

/**
 * Every /api route checks the IP allow-list and needs a Supabase session
 * (users sign in from the browser; this API only verifies their token).
 */
export const apiRoutes = Router();

apiRoutes.use(requireAllowedIp);
apiRoutes.use(requireAuth);
apiRoutes.use('/auth', authRoutes);
apiRoutes.get('/health', health);
apiRoutes.use('/countries', countryRoutes);
apiRoutes.use('/extractions', extractionRoutes);
apiRoutes.use('/runs', runRoutes);
apiRoutes.use('/files', fileRoutes);
apiRoutes.use('/admin', adminRoutes);
