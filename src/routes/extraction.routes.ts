import { Router } from 'express';
import * as extractions from '../controllers/extraction.controller';
import { validateBody } from '../middlewares/validate.middleware';
import { extractionSchema } from '../schemas';

export const extractionRoutes = Router();

extractionRoutes.post('/', validateBody(extractionSchema), extractions.start);
extractionRoutes.post('/daily-check', extractions.dailyCheck);
