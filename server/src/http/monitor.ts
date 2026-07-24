import { Router } from 'express';
import type { JobSummary } from '@transformata/shared';
import { conflict, notFound } from '../errors.js';
import {
  createJob,
  getJob,
  getJobRawPayload,
  isJobStatus,
  jobBus,
  listJobs,
  stats,
} from '../queue/queue.js';

export function createMonitorRouter(): Router {
  const router = Router();

  router.get('/jobs', (req, res) => {
    const statusRaw = req.query.status;
    let status;
    if (typeof statusRaw === 'string' && statusRaw !== '') {
      if (!isJobStatus(statusRaw)) {
        res.status(400).json({ error: `invalid status "${statusRaw}"` });
        return;
      }
      status = statusRaw;
    }
    const funnelId =
      typeof req.query.funnelId === 'string' && req.query.funnelId !== ''
        ? req.query.funnelId
        : undefined;
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    res.json(listJobs({ status, funnelId, limit, offset }));
  });

  router.get('/jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) throw notFound(`job "${req.params.id}" not found`);
    res.json(job);
  });

  router.post('/jobs/:id/retry', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) throw notFound(`job "${req.params.id}" not found`);
    const raw = getJobRawPayload(req.params.id);
    if (raw === null || raw === '') {
      throw conflict(`job "${req.params.id}" has no stored payload to retry`);
    }
    const retried = createJob(
      {
        endpointId: job.source.endpointId,
        endpointName: job.source.endpointName,
        via: 'retry',
        fileName: job.source.fileName,
        retryOf: job.id,
      },
      raw,
    );
    res.status(202).json({ jobId: retried.id });
  });

  router.get('/stats', (_req, res) => {
    res.json(stats());
  });

  router.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Initial stats snapshot so the UI can render immediately.
    send('stats', stats());

    const onJob = (job: JobSummary): void => {
      send('job', job);
      send('stats', stats());
    };
    jobBus.on('job', onJob);

    const ping = setInterval(() => {
      res.write(': ping\n\n');
    }, 25_000);

    req.on('close', () => {
      clearInterval(ping);
      jobBus.off('job', onJob);
      res.end();
    });
  });

  return router;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
