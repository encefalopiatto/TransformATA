import { Router } from 'express';
import type {
  ConfigBundle,
  Endpoint,
  FunnelConfig,
  TestEndpointResponse,
  TestFunnelResponse,
  TransformConfig,
} from '@transformata/shared';
import {
  createEndpoint,
  createFunnel,
  createTransform,
  deleteEndpoint,
  deleteFunnel,
  deleteTransform,
  getEndpoint,
  getFunnel,
  getTransform,
  isTransformKind,
  listEndpoints,
  listFunnels,
  listTransforms,
  updateEndpoint,
  updateFunnel,
  updateTransform,
  upsertEndpoint,
  upsertFunnel,
  upsertTransform,
} from '../config-store.js';
import { deliverToEndpoint } from '../egress/deliver.js';
import { badRequest, errorMessage, notFound } from '../errors.js';
import { generateJobId } from '../ids.js';
import { testPollEndpoint } from '../ingress/sftp-poll.js';
import { evalJsonata } from '../jsonata-runner.js';
import { runPipeline } from '../pipeline/engine.js';
import { asyncHandler } from './util.js';

export function createAdminRouter(): Router {
  const router = Router();

  /* ------------------------------ transforms ------------------------------ */

  router.get('/transforms', (req, res) => {
    const kindRaw = req.query.kind;
    if (kindRaw !== undefined && kindRaw !== '') {
      if (!isTransformKind(kindRaw)) {
        throw badRequest(`invalid kind "${String(kindRaw)}"`);
      }
      res.json(listTransforms(kindRaw));
      return;
    }
    res.json(listTransforms());
  });

  router.post('/transforms', (req, res) => {
    res.status(201).json(createTransform(req.body));
  });

  router.get('/transforms/:id', (req, res) => {
    const transform = getTransform(req.params.id);
    if (!transform) throw notFound(`transform "${req.params.id}" not found`);
    res.json(transform);
  });

  router.put('/transforms/:id', (req, res) => {
    res.json(updateTransform(req.params.id, req.body));
  });

  router.delete('/transforms/:id', (req, res) => {
    deleteTransform(req.params.id);
    res.status(204).end();
  });

  /* -------------------------------- funnels ------------------------------- */

  router.get('/funnels', (_req, res) => {
    res.json(listFunnels());
  });

  router.post('/funnels', (req, res) => {
    res.status(201).json(createFunnel(req.body));
  });

  router.get('/funnels/:id', (req, res) => {
    const funnel = getFunnel(req.params.id);
    if (!funnel) throw notFound(`funnel "${req.params.id}" not found`);
    res.json(funnel);
  });

  router.put('/funnels/:id', (req, res) => {
    res.json(updateFunnel(req.params.id, req.body));
  });

  router.delete('/funnels/:id', (req, res) => {
    deleteFunnel(req.params.id);
    res.status(204).end();
  });

  router.post(
    '/funnels/:id/test',
    asyncHandler(async (req, res) => {
      const funnel = getFunnel(req.params.id);
      if (!funnel) throw notFound(`funnel "${req.params.id}" not found`);
      const body: unknown = req.body;
      if (
        typeof body !== 'object' ||
        body === null ||
        typeof (body as { content?: unknown }).content !== 'string'
      ) {
        throw badRequest('"content" (string) is required');
      }
      const { content, fileName, deliver } = body as {
        content: string;
        fileName?: string;
        deliver?: boolean;
      };
      const result = await runPipeline(content, {
        jobId: `test-${generateJobId()}`,
        source: { endpointId: 'admin-test', via: 'test', fileName },
        forcedFunnel: funnel,
        deliver: deliver === true,
        persistCanonical: false,
      });
      const response: TestFunnelResponse = {
        ok: result.ok,
        stages: result.stages,
        ...(result.outputText !== undefined ? { outputText: result.outputText } : {}),
      };
      res.json(response);
    }),
  );

  /* ------------------------------- endpoints ------------------------------- */

  router.get('/endpoints', (req, res) => {
    const direction = req.query.direction;
    if (direction !== undefined && direction !== '') {
      if (direction !== 'inbound' && direction !== 'outbound') {
        throw badRequest(`invalid direction "${String(direction)}"`);
      }
      res.json(listEndpoints(direction));
      return;
    }
    res.json(listEndpoints());
  });

  router.post('/endpoints', (req, res) => {
    res.status(201).json(createEndpoint(req.body));
  });

  router.get('/endpoints/:id', (req, res) => {
    const endpoint = getEndpoint(req.params.id);
    if (!endpoint) throw notFound(`endpoint "${req.params.id}" not found`);
    res.json(endpoint);
  });

  router.put('/endpoints/:id', (req, res) => {
    res.json(updateEndpoint(req.params.id, req.body));
  });

  router.delete('/endpoints/:id', (req, res) => {
    deleteEndpoint(req.params.id);
    res.status(204).end();
  });

  router.post(
    '/endpoints/:id/test',
    asyncHandler(async (req, res) => {
      const endpoint = getEndpoint(req.params.id);
      if (!endpoint) throw notFound(`endpoint "${req.params.id}" not found`);
      const content =
        typeof (req.body as { content?: unknown } | undefined)?.content === 'string'
          ? (req.body as { content: string }).content
          : undefined;

      let response: TestEndpointResponse;
      if (endpoint.direction === 'outbound') {
        const text =
          content ??
          JSON.stringify(
            { transformata: 'endpoint test', endpointId: endpoint.id, at: new Date().toISOString() },
            null,
            2,
          );
        const fileName = `transformata-test-${Date.now()}.json`;
        try {
          const deliveredTo = await deliverToEndpoint(endpoint, fileName, text, 'json');
          response = { ok: true, detail: `delivered test payload to ${deliveredTo}` };
        } catch (err) {
          response = { ok: false, detail: errorMessage(err) };
        }
      } else if (endpoint.kind === 'sftp-poll') {
        try {
          response = { ok: true, detail: await testPollEndpoint(endpoint) };
        } catch (err) {
          response = { ok: false, detail: errorMessage(err) };
        }
      } else {
        throw badRequest(
          `inbound "${endpoint.kind}" endpoints cannot be tested — only outbound endpoints and inbound sftp-poll endpoints support test`,
        );
      }
      res.json(response);
    }),
  );

  /* -------------------------------- utilities ------------------------------ */

  router.post(
    '/evaluate',
    asyncHandler(async (req, res) => {
      const body: unknown = req.body;
      if (
        typeof body !== 'object' ||
        body === null ||
        typeof (body as { expression?: unknown }).expression !== 'string'
      ) {
        throw badRequest('"expression" (string) is required');
      }
      const { expression, input } = body as { expression: string; input: unknown };
      res.json(await evalJsonata(expression, input));
    }),
  );

  router.get('/export', (_req, res) => {
    const bundle: ConfigBundle = {
      version: 1,
      exportedAt: new Date().toISOString(),
      endpoints: listEndpoints(),
      funnels: listFunnels(),
      transforms: listTransforms(),
    };
    res.setHeader('Content-Disposition', 'attachment; filename="transformata-config.json"');
    res.json(bundle);
  });

  router.post('/import', (req, res) => {
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null) {
      throw badRequest('request body must be a ConfigBundle object');
    }
    const bundle = body as Partial<ConfigBundle>;
    const endpoints = Array.isArray(bundle.endpoints) ? bundle.endpoints : [];
    const funnels = Array.isArray(bundle.funnels) ? bundle.funnels : [];
    const transforms = Array.isArray(bundle.transforms) ? bundle.transforms : [];

    let importedEndpoints = 0;
    for (const endpoint of endpoints) {
      if (isImportable(endpoint)) {
        upsertEndpoint(endpoint as Endpoint);
        importedEndpoints += 1;
      }
    }
    let importedFunnels = 0;
    for (const funnel of funnels) {
      if (isImportable(funnel)) {
        upsertFunnel(funnel as FunnelConfig);
        importedFunnels += 1;
      }
    }
    let importedTransforms = 0;
    for (const transform of transforms) {
      if (isImportable(transform) && isTransformKind((transform as TransformConfig).kind)) {
        upsertTransform(transform as TransformConfig);
        importedTransforms += 1;
      }
    }
    res.json({
      imported: {
        endpoints: importedEndpoints,
        funnels: importedFunnels,
        transforms: importedTransforms,
      },
    });
  });

  return router;
}

function isImportable(value: unknown): value is { id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id.trim() !== ''
  );
}
