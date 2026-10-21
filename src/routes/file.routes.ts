import { Router } from 'express';
import * as files from '../controllers/file.controller';

export const fileRoutes = Router();

fileRoutes.get('/', files.list);
fileRoutes.get('/download', files.download);
fileRoutes.delete('/', files.remove);
