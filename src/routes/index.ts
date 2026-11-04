import { Router } from 'express';
import { health } from '../controllers/health.controller';
import { download as serverFileDownload } from '../controllers/server-files.controller';
import { requireAllowedIp, requireAuth } from '../middlewares/auth.middleware';
import { countryRoutes } from './country.routes';
import { extractionRoutes } from './extraction.routes';
import { mergeRoutes } from './merge.routes';
import { runRoutes } from './run.routes';
import { serverFileRoutes } from './server-files.routes';
import { settingsRoutes } from './settings.routes';

/**
 * Every /api route checks the IP allow-list. Health is open so the web app can tell whether the
 * service is up, and so is a server file's download link (it carries its own signature, so the
 * browser can stream it as a normal download); everything else needs a Supabase session (sign-in
 * happens in the web app).
 */
export const apiRoutes = Router();

apiRoutes.use(requireAllowedIp);
apiRoutes.get('/health', health);
apiRoutes.get('/server-files/download', serverFileDownload);
apiRoutes.use(requireAuth);
apiRoutes.use('/countries', countryRoutes);
apiRoutes.use('/extractions', extractionRoutes);
apiRoutes.use('/merges', mergeRoutes);
apiRoutes.use('/runs', runRoutes);
apiRoutes.use('/server-files', serverFileRoutes);
apiRoutes.use('/settings', settingsRoutes);
