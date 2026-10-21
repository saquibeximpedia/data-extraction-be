import express from 'express';
import cors from 'cors';
import { apiRoutes } from './routes';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';

/** The Express app: JSON API only (the UI is the separate Next.js app in the data-extraction-web repo) */
export const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Request log, with tokens and passwords stripped from query strings
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const url = req.originalUrl.replace(/([?&](?:token|password)=)[^&]*/gi, '$1***');
    console.log(`[${new Date().toISOString()}] ${req.method} ${url} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get('/', (_req, res) => {
  res.json({ service: 'Trade data extraction API', docs: 'See README.md' });
});

app.use('/api', apiRoutes);
app.use('/api', notFoundHandler);
app.use(errorHandler);
