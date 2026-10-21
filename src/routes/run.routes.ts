import { Router } from 'express';
import * as runs from '../controllers/run.controller';

export const runRoutes = Router();

runRoutes.get('/', runs.list);
runRoutes.get('/:id', runs.getOne);
runRoutes.post('/:id/stop', runs.stop);
runRoutes.get('/:id/logs', runs.logs);
