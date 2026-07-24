import fs from 'node:fs';
import path from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import type {
  DataFormat,
  Endpoint,
  FunnelConfig,
  OutboundEndpoint,
} from '@transformata/shared';
import { getEndpoint } from '../config-store.js';
import { errorMessage } from '../errors.js';
import { resolveContainedDir } from '../root.js';

const CONTENT_TYPES: Record<DataFormat, string> = {
  json: 'application/json',
  csv: 'text/csv',
  xml: 'application/xml',
};

const EXTENSIONS: Record<DataFormat, string> = {
  json: 'json',
  csv: 'csv',
  xml: 'xml',
};

/**
 * Render the delivered file name from the funnel's template.
 * Supports {jobId}, {date} (YYYY-MM-DD), {time} (HHmmss), {funnelId}.
 * Default: `job-{jobId}.<ext by outputFormat>`.
 */
export function renderFileName(funnel: FunnelConfig, jobId: string): string {
  const template =
    funnel.outputFileName && funnel.outputFileName.trim() !== ''
      ? funnel.outputFileName
      : `job-{jobId}.${EXTENSIONS[funnel.outputFormat]}`;
  const now = new Date().toISOString();
  const date = now.slice(0, 10); // YYYY-MM-DD
  const time = now.slice(11, 19).replace(/:/g, ''); // HHmmss
  const name = template
    .replaceAll('{jobId}', jobId)
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{funnelId}', funnel.id);
  // File names must not escape the target directory.
  return path.basename(name);
}

export interface DeliveryResult {
  endpoint: Endpoint;
  fileName: string;
  deliveredTo: string;
}

/** Deliver serialized output text through the funnel's outbound endpoint. */
export async function deliver(
  text: string,
  funnel: FunnelConfig,
  jobId: string,
): Promise<DeliveryResult> {
  const endpoint = getEndpoint(funnel.outputEndpointId);
  if (!endpoint) {
    throw new Error(`outbound endpoint "${funnel.outputEndpointId}" not found`);
  }
  if (endpoint.direction !== 'outbound') {
    throw new Error(`endpoint "${endpoint.id}" is not an outbound endpoint`);
  }
  if (endpoint.enabled === false) {
    throw new Error(`outbound endpoint "${endpoint.id}" is disabled`);
  }
  const fileName = renderFileName(funnel, jobId);
  const deliveredTo = await deliverToEndpoint(endpoint, fileName, text, funnel.outputFormat);
  return { endpoint, fileName, deliveredTo };
}

/**
 * Low-level delivery to an outbound endpoint; returns a human-readable
 * "delivered to" description (file path, URL + status, or sftp URI).
 * Shared by the pipeline and the admin endpoint-test route.
 */
export async function deliverToEndpoint(
  endpoint: OutboundEndpoint,
  fileName: string,
  text: string,
  format: DataFormat = 'json',
): Promise<string> {
  switch (endpoint.kind) {
    case 'directory': {
      const dir = resolveContainedDir(endpoint.path);
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, fileName);
      fs.writeFileSync(target, text, 'utf8');
      return target;
    }
    case 'api': {
      const method = endpoint.method ?? 'POST';
      const headers: Record<string, string> = {
        'Content-Type': CONTENT_TYPES[format],
        ...endpoint.headers,
      };
      let response: Response;
      try {
        response = await fetch(endpoint.url, { method, headers, body: text });
      } catch (err) {
        throw new Error(`${method} ${endpoint.url} failed: ${errorMessage(err)}`);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `${method} ${endpoint.url} returned ${response.status}: ${body.slice(0, 200)}`,
        );
      }
      return `${method} ${endpoint.url} → ${response.status}`;
    }
    case 'sftp': {
      const client = new SftpClient();
      const port = endpoint.port ?? 22;
      const remotePath = path.posix.join(endpoint.remoteDir, fileName);
      try {
        await client.connect({
          host: endpoint.host,
          port,
          username: endpoint.username,
          password: endpoint.password,
          privateKey: endpoint.privateKey,
          readyTimeout: 15_000,
        });
        await client.mkdir(endpoint.remoteDir, true).catch(() => undefined); // may already exist
        await client.put(Buffer.from(text, 'utf8'), remotePath);
      } finally {
        await client.end().catch(() => undefined);
      }
      return `sftp://${endpoint.host}:${port}${remotePath.startsWith('/') ? '' : '/'}${remotePath}`;
    }
  }
}
