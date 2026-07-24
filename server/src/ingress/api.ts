import express, { Router } from 'express';
import { getEndpoint } from '../config-store.js';
import { createJob } from '../queue/queue.js';

/**
 * POST /api/inbound/:endpointId — HTTP push ingress.
 * Body is read as raw text (any Content-Type, 10 MB limit); auth via
 * X-Api-Key matching the endpoint's apiKey. Returns 202 { jobId }.
 */
export function createInboundRouter(): Router {
  const router = Router();

  router.post(
    '/:endpointId',
    express.text({ type: '*/*', limit: '10mb' }),
    (req, res) => {
      const endpoint = getEndpoint(req.params.endpointId);
      if (
        !endpoint ||
        endpoint.direction !== 'inbound' ||
        endpoint.kind !== 'api' ||
        endpoint.enabled === false
      ) {
        res.status(404).json({ error: `unknown inbound API endpoint "${req.params.endpointId}"` });
        return;
      }
      const apiKey = req.header('x-api-key');
      if (!apiKey || apiKey !== endpoint.apiKey) {
        res.status(401).json({ error: 'invalid or missing X-Api-Key' });
        return;
      }
      const raw = typeof req.body === 'string' ? req.body : '';
      if (raw === '') {
        res.status(400).json({ error: 'request body is empty' });
        return;
      }
      const fileName = req.header('x-file-name') ?? undefined;
      const job = createJob(
        { endpointId: endpoint.id, endpointName: endpoint.name, via: 'api', fileName },
        raw,
      );
      res.status(202).json({ jobId: job.id });
    },
  );

  return router;
}
