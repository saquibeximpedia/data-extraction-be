import express, { Router } from 'express';
import { env } from '../config/env';
import * as files from '../controllers/file.controller';

export const fileRoutes = Router();

fileRoutes.get('/', files.list);
fileRoutes.get('/url', files.url);
fileRoutes.post('/zip', files.zip);
fileRoutes.post('/delete', files.remove);
fileRoutes.put('/upload', express.raw({ type: () => true, limit: `${env.UPLOAD_MAX_MB}mb` }), files.upload);
