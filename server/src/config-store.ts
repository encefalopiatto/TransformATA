import fs from 'node:fs';
import path from 'node:path';
import type {
  Endpoint,
  EndpointDirection,
  FunnelConfig,
  TransformConfig,
  TransformKind,
} from '@transformata/shared';
import { badRequest, conflict, notFound } from './errors.js';
import { generateConfigId } from './ids.js';
import { fromRoot } from './root.js';

/**
 * File-backed config store. One JSON file per object, filename `<id>.json`.
 * Reads happen on every list/get (files are small → free hot reload); writes
 * go straight to disk.
 */

const ENDPOINTS_DIR = ['config', 'endpoints'];
const FUNNELS_DIR = ['config', 'funnels'];

export const TRANSFORM_DIRS: Record<TransformKind, string[]> = {
  normalization: ['config', 'normalizations'],
  transformation: ['config', 'transformations'],
  denormalization: ['config', 'denormalizations'],
};

export const TRANSFORM_KINDS: TransformKind[] = [
  'normalization',
  'transformation',
  'denormalization',
];

/* ----------------------------- file helpers ----------------------------- */

function dirPath(segments: string[]): string {
  return fromRoot(...segments);
}

function readAll<T extends { id: string }>(segments: string[]): T[] {
  const dir = dirPath(segments);
  if (!fs.existsSync(dir)) return [];
  const out: T[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(dir, file);
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as T).id === 'string') {
        out.push(parsed as T);
      } else {
        console.warn(`[config] skipping ${full}: not an object with a string "id"`);
      }
    } catch (err) {
      console.warn(
        `[config] skipping unreadable ${full}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

function readOne<T extends { id: string }>(segments: string[], id: string): T | undefined {
  if (!isSafeId(id)) return undefined;
  const file = path.join(dirPath(segments), `${id}.json`);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') return parsed as T;
  } catch (err) {
    console.warn(
      `[config] failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return undefined;
}

function writeOne(segments: string[], id: string, value: unknown): void {
  if (!isSafeId(id)) throw badRequest(`invalid id "${id}"`);
  const dir = dirPath(segments);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function removeOne(segments: string[], id: string): boolean {
  if (!isSafeId(id)) return false;
  const file = path.join(dirPath(segments), `${id}.json`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** Ids become filenames — keep them strictly to slug characters. */
function isSafeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireName(body: Record<string, unknown>): string {
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    throw badRequest('"name" (non-empty string) is required');
  }
  return body.name.trim();
}

/* ------------------------------- endpoints ------------------------------ */

export function listEndpoints(direction?: EndpointDirection): Endpoint[] {
  const all = readAll<Endpoint>(ENDPOINTS_DIR);
  return direction ? all.filter((e) => e.direction === direction) : all;
}

export function getEndpoint(id: string): Endpoint | undefined {
  return readOne<Endpoint>(ENDPOINTS_DIR, id);
}

const ENDPOINT_KINDS: Record<EndpointDirection, string[]> = {
  inbound: ['api', 'sftp', 'sftp-poll'],
  outbound: ['api', 'sftp', 'directory'],
};

function validateEndpointShape(body: Record<string, unknown>): void {
  const direction = body.direction;
  if (direction !== 'inbound' && direction !== 'outbound') {
    throw badRequest('"direction" must be "inbound" or "outbound"');
  }
  const kind = body.kind;
  if (typeof kind !== 'string' || !ENDPOINT_KINDS[direction].includes(kind)) {
    throw badRequest(
      `"kind" must be one of ${ENDPOINT_KINDS[direction].join(', ')} for ${direction} endpoints`,
    );
  }
}

export function createEndpoint(body: unknown): Endpoint {
  if (!isRecord(body)) throw badRequest('request body must be a JSON object');
  const name = requireName(body);
  validateEndpointShape(body);
  const endpoint = { ...body, name, id: generateConfigId(name) } as Endpoint;
  writeOne(ENDPOINTS_DIR, endpoint.id, endpoint);
  return endpoint;
}

export function updateEndpoint(id: string, patch: unknown): Endpoint {
  const existing = getEndpoint(id);
  if (!existing) throw notFound(`endpoint "${id}" not found`);
  if (!isRecord(patch)) throw badRequest('request body must be a JSON object');
  const merged = { ...existing, ...patch, id } as unknown as Record<string, unknown>;
  validateEndpointShape(merged);
  const endpoint = merged as unknown as Endpoint;
  writeOne(ENDPOINTS_DIR, id, endpoint);
  return endpoint;
}

export function deleteEndpoint(id: string): void {
  const existing = getEndpoint(id);
  if (!existing) throw notFound(`endpoint "${id}" not found`);
  const refs = listFunnels().filter(
    (f) => f.outputEndpointId === id || (f.inboundEndpointIds ?? []).includes(id),
  );
  if (refs.length > 0) {
    throw conflict(
      `endpoint "${id}" is referenced by funnel(s): ${refs.map((f) => f.name).join(', ')}`,
    );
  }
  removeOne(ENDPOINTS_DIR, id);
}

/** Import upsert: keeps the provided id. */
export function upsertEndpoint(endpoint: Endpoint): void {
  writeOne(ENDPOINTS_DIR, endpoint.id, endpoint);
}

/* -------------------------------- funnels ------------------------------- */

export function listFunnels(): FunnelConfig[] {
  return readAll<FunnelConfig>(FUNNELS_DIR).sort((a, b) => a.priority - b.priority);
}

export function getFunnel(id: string): FunnelConfig | undefined {
  return readOne<FunnelConfig>(FUNNELS_DIR, id);
}

const DATA_FORMATS = ['json', 'csv', 'xml'];

function validateFunnelShape(body: Record<string, unknown>): void {
  const match = body.match;
  if (!isRecord(match) || typeof match.expression !== 'string' || match.expression.trim() === '') {
    throw badRequest('"match.expression" (non-empty JSONata string) is required');
  }
  if (!DATA_FORMATS.includes(body.inputFormat as string)) {
    throw badRequest('"inputFormat" must be one of json, csv, xml');
  }
  if (!DATA_FORMATS.includes(body.outputFormat as string)) {
    throw badRequest('"outputFormat" must be one of json, csv, xml');
  }
  if (typeof body.outputEndpointId !== 'string' || body.outputEndpointId.trim() === '') {
    throw badRequest('"outputEndpointId" is required');
  }
}

export function createFunnel(body: unknown): FunnelConfig {
  if (!isRecord(body)) throw badRequest('request body must be a JSON object');
  const name = requireName(body);
  const withDefaults: Record<string, unknown> = {
    enabled: true,
    priority: 100,
    ...body,
    name,
  };
  validateFunnelShape(withDefaults);
  const funnel = { ...withDefaults, id: generateConfigId(name) } as unknown as FunnelConfig;
  writeOne(FUNNELS_DIR, funnel.id, funnel);
  return funnel;
}

export function updateFunnel(id: string, patch: unknown): FunnelConfig {
  const existing = getFunnel(id);
  if (!existing) throw notFound(`funnel "${id}" not found`);
  if (!isRecord(patch)) throw badRequest('request body must be a JSON object');
  const merged = { ...existing, ...patch, id } as unknown as Record<string, unknown>;
  validateFunnelShape(merged);
  const funnel = merged as unknown as FunnelConfig;
  writeOne(FUNNELS_DIR, id, funnel);
  return funnel;
}

export function deleteFunnel(id: string): void {
  const existing = getFunnel(id);
  if (!existing) throw notFound(`funnel "${id}" not found`);
  removeOne(FUNNELS_DIR, id);
}

export function upsertFunnel(funnel: FunnelConfig): void {
  writeOne(FUNNELS_DIR, funnel.id, funnel);
}

/* ------------------------------ transforms ------------------------------ */

export function listTransforms(kind?: TransformKind): TransformConfig[] {
  const kinds = kind ? [kind] : TRANSFORM_KINDS;
  const out: TransformConfig[] = [];
  for (const k of kinds) {
    for (const t of readAll<TransformConfig>(TRANSFORM_DIRS[k])) {
      out.push({ ...t, kind: k });
    }
  }
  return out;
}

export function getTransform(id: string): TransformConfig | undefined {
  for (const k of TRANSFORM_KINDS) {
    const found = readOne<TransformConfig>(TRANSFORM_DIRS[k], id);
    if (found) return { ...found, kind: k };
  }
  return undefined;
}

export function isTransformKind(value: unknown): value is TransformKind {
  return typeof value === 'string' && (TRANSFORM_KINDS as string[]).includes(value);
}

export function createTransform(body: unknown): TransformConfig {
  if (!isRecord(body)) throw badRequest('request body must be a JSON object');
  const name = requireName(body);
  if (!isTransformKind(body.kind)) {
    throw badRequest('"kind" must be one of normalization, transformation, denormalization');
  }
  const transform: TransformConfig = {
    id: generateConfigId(name),
    name,
    kind: body.kind,
    description: typeof body.description === 'string' ? body.description : undefined,
    jsonata: typeof body.jsonata === 'string' && body.jsonata.trim() !== '' ? body.jsonata : '$',
    graph: (body.graph ?? null) as TransformConfig['graph'],
    sampleInput: body.sampleInput,
    updatedAt: new Date().toISOString(),
  };
  writeOne(TRANSFORM_DIRS[transform.kind], transform.id, transform);
  return transform;
}

export function updateTransform(id: string, patch: unknown): TransformConfig {
  const existing = getTransform(id);
  if (!existing) throw notFound(`transform "${id}" not found`);
  if (!isRecord(patch)) throw badRequest('request body must be a JSON object');
  // id and kind are immutable.
  const merged = {
    ...existing,
    ...patch,
    id,
    kind: existing.kind,
    updatedAt: new Date().toISOString(),
  } as TransformConfig;
  if (typeof merged.jsonata !== 'string') throw badRequest('"jsonata" must be a string');
  writeOne(TRANSFORM_DIRS[existing.kind], id, merged);
  return merged;
}

export function deleteTransform(id: string): void {
  const existing = getTransform(id);
  if (!existing) throw notFound(`transform "${id}" not found`);
  const refs = listFunnels().filter(
    (f) => f.normalizationId === id || f.transformationId === id || f.denormalizationId === id,
  );
  if (refs.length > 0) {
    throw conflict(
      `transform "${id}" is referenced by funnel(s): ${refs.map((f) => f.name).join(', ')}`,
    );
  }
  removeOne(TRANSFORM_DIRS[existing.kind], id);
}

export function upsertTransform(transform: TransformConfig): void {
  if (!isTransformKind(transform.kind)) {
    throw badRequest(`transform "${transform.id}" has invalid kind "${String(transform.kind)}"`);
  }
  writeOne(TRANSFORM_DIRS[transform.kind], transform.id, transform);
}
