import { Router } from 'express';
import { health } from '../controllers/health.controller';
import { requireAllowedIp, requireAuth } from '../middlewares/auth.middleware';
import { countryRoutes } from './country.routes';
import { extractionRoutes } from './extraction.routes';
import { runRoutes } from './run.routes';
import { settingsRoutes } from './settings.routes';

/**
 * Every /api route checks the IP allow-list. Health is open so the web app can tell whether the
 * service is up; everything else needs a Supabase session (sign-in happens in the web app).
 */
export const apiRoutes = Router();

apiRoutes.use(requireAllowedIp);
apiRoutes.get('/health', health);
apiRoutes.use(requireAuth);
apiRoutes.use('/countries', countryRoutes);
apiRoutes.use('/extractions', extractionRoutes);
apiRoutes.use('/runs', runRoutes);
apiRoutes.use('/settings', settingsRoutes);
