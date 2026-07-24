import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { errorMessage, HttpError } from '../errors.js';
import { createInboundRouter } from '../ingress/api.js';
import { fromRoot } from '../root.js';
import { createAdminRouter } from './admin.js';
import { createMonitorRouter } from './monitor.js';

function appVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(fromRoot('package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors()); // permissive by design (MVP)

  const version = appVersion();
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version });
  });

  // Ingress reads the body as raw text — mounted before the JSON parser.
  app.use('/api/inbound', createInboundRouter());

  app.use('/api/monitor', createMonitorRouter());
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/admin', createAdminRouter());

  // Unknown API route → JSON 404.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `unknown API route: ${req.method} ${req.path}` });
  });

  // Serve the built web app (when present) with an SPA fallback for
  // non-/api GETs without a file extension.
  const webDist = fromRoot('web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || path.extname(req.path) !== '') {
        next();
        return;
      }
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  // Error middleware: everything becomes { error } JSON.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      err instanceof HttpError
        ? err.status
        : typeof (err as { status?: unknown })?.status === 'number'
          ? ((err as { status: number }).status as number)
          : typeof (err as { statusCode?: unknown })?.statusCode === 'number'
            ? (err as { statusCode: number }).statusCode
            : 500;
    if (status >= 500) console.error('[http] internal error:', err);
    res.status(status).json({ error: errorMessage(err) });
  });

  return app;
}
