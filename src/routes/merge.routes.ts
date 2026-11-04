import { Router } from 'express';
import * as merges from '../controllers/merge.controller';
import { validateBody } from '../middlewares/validate.middleware';
import { mergeSchema } from '../schemas';

export const mergeRoutes = Router();

mergeRoutes.post('/', validateBody(mergeSchema), merges.start);
mergeRoutes.get('/', merges.list);
mergeRoutes.get('/:id', merges.getOne);
