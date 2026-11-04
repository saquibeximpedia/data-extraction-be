import { Router } from 'express';
import * as serverFiles from '../controllers/server-files.controller';
import { validateBody } from '../middlewares/validate.middleware';
import { serverFilePathsSchema } from '../schemas';

/** Needs sign-in; the download route itself is mounted before sign-in (its link is signed) */
export const serverFileRoutes = Router();

serverFileRoutes.get('/', serverFiles.list);
serverFileRoutes.post('/links', validateBody(serverFilePathsSchema), serverFiles.links);
serverFileRoutes.delete('/', validateBody(serverFilePathsSchema), serverFiles.remove);
