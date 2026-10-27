import { Router } from 'express';
import * as settings from '../controllers/settings.controller';
import { requireAdmin } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate.middleware';
import { appSettingsSchema } from '../schemas';

export const settingsRoutes = Router();

settingsRoutes.get('/', settings.get);
settingsRoutes.put('/', requireAdmin, validateBody(appSettingsSchema.partial()), settings.update);
