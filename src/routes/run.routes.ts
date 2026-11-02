import { Router } from 'express';
import * as runs from '../controllers/run.controller';

export const runRoutes = Router();

runRoutes.get('/', runs.list);
runRoutes.get('/:id', runs.getOne);
runRoutes.post('/:id/stop', runs.stop);
runRoutes.get('/:id/logs', runs.logs);
runRoutes.get('/:id/held', runs.heldList);
runRoutes.get('/:id/held/file', runs.heldFile);
runRoutes.delete('/:id/held', runs.heldRemove);
