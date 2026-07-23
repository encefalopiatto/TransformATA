import path from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import type { InboundSftpPollEndpoint } from '@transformata/shared';
import { getEndpoint, listEndpoints } from '../config-store.js';
import { errorMessage } from '../errors.js';
import { createJob } from '../queue/queue.js';

/**
 * SFTP polling ingress: for each enabled inbound `sftp-poll` endpoint, poll
 * the remote directory on its interval, ingest matching files as jobs, then
 * delete or move them per `afterFetch`. Endpoint config is re-read on every
 * tick (hot reload); connection errors are logged and retried next tick —
 * they never crash the process. Overlapping polls per endpoint are guarded.
 */

const RECONCILE_INTERVAL_MS = 10_000;

interface PollerEntry {
  timer: NodeJS.Timeout;
  intervalSec: number;
  running: boolean;
}

/** Convert a simple glob (`*` and `?` only) to a RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function activePollEndpoints(): InboundSftpPollEndpoint[] {
  const out: InboundSftpPollEndpoint[] = [];
  for (const endpoint of listEndpoints('inbound')) {
    if (endpoint.kind === 'sftp-poll' && endpoint.enabled !== false) out.push(endpoint);
  }
  return out;
}

export function startSftpPollers(): () => void {
  const pollers = new Map<string, PollerEntry>();

  const reconcile = (): void => {
    let endpoints: InboundSftpPollEndpoint[];
    try {
      endpoints = activePollEndpoints();
    } catch (err) {
      console.error(`[sftp-poll] failed to read endpoints: ${errorMessage(err)}`);
      return;
    }
    // Drop pollers whose endpoint disappeared or was disabled.
    for (const [id, entry] of pollers) {
      if (!endpoints.some((e) => e.id === id)) {
        clearInterval(entry.timer);
        pollers.delete(id);
        console.log(`[sftp-poll] stopped poller for endpoint ${id}`);
      }
    }
    // Start/refresh pollers.
    for (const endpoint of endpoints) {
      const intervalSec = endpoint.pollIntervalSec ?? 60;
      const existing = pollers.get(endpoint.id);
      if (existing && existing.intervalSec === intervalSec) continue;
      if (existing) clearInterval(existing.timer);
      const entry: PollerEntry = { intervalSec, running: false, timer: undefined as never };
      entry.timer = setInterval(() => {
        void pollEndpoint(endpoint.id, entry);
      }, intervalSec * 1000);
      entry.timer.unref();
      pollers.set(endpoint.id, entry);
      console.log(
        `[sftp-poll] polling endpoint ${endpoint.id} (${endpoint.host}) every ${intervalSec}s`,
      );
    }
  };

  reconcile();
  const reconcileTimer = setInterval(reconcile, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();

  return () => {
    clearInterval(reconcileTimer);
    for (const entry of pollers.values()) clearInterval(entry.timer);
    pollers.clear();
  };
}

async function pollEndpoint(endpointId: string, entry: PollerEntry): Promise<void> {
  if (entry.running) return; // guard against overlapping polls
  entry.running = true;
  try {
    // Re-read the endpoint so config edits apply on the next tick.
    const endpoint = getEndpoint(endpointId);
    if (
      !endpoint ||
      endpoint.direction !== 'inbound' ||
      endpoint.kind !== 'sftp-poll' ||
      endpoint.enabled === false
    ) {
      return;
    }
    await pollOnce(endpoint);
  } catch (err) {
    console.error(`[sftp-poll] poll of endpoint ${endpointId} failed: ${errorMessage(err)}`);
  } finally {
    entry.running = false;
  }
}

async function pollOnce(endpoint: InboundSftpPollEndpoint): Promise<void> {
  const client = new SftpClient();
  try {
    await client.connect({
      host: endpoint.host,
      port: endpoint.port ?? 22,
      username: endpoint.username,
      password: endpoint.password,
      privateKey: endpoint.privateKey,
      readyTimeout: 15_000,
    });
    const pattern = endpoint.filePattern ? globToRegExp(endpoint.filePattern) : undefined;
    const listing = await client.list(endpoint.remoteDir);
    const files = listing.filter(
      (item) => item.type === '-' && (!pattern || pattern.test(item.name)),
    );
    if (files.length === 0) return;

    const afterFetch = endpoint.afterFetch ?? 'move';
    const moveToDir = endpoint.moveToDir ?? path.posix.join(endpoint.remoteDir, 'processed');
    if (afterFetch === 'move') {
      await client.mkdir(moveToDir, true).catch(() => undefined); // may already exist
    }

    for (const file of files) {
      const remotePath = path.posix.join(endpoint.remoteDir, file.name);
      try {
        const content = await client.get(remotePath);
        const text = Buffer.isBuffer(content)
          ? content.toString('utf8')
          : String(content);
        const job = createJob(
          {
            endpointId: endpoint.id,
            endpointName: endpoint.name,
            via: 'sftp-poll',
            fileName: file.name,
          },
          text,
        );
        console.log(
          `[sftp-poll] ingested "${file.name}" from ${endpoint.host}:${endpoint.remoteDir} → job ${job.id}`,
        );
        if (afterFetch === 'delete') {
          await client.delete(remotePath);
        } else {
          await client.rename(remotePath, path.posix.join(moveToDir, file.name));
        }
      } catch (err) {
        // Leave the file in place; it will be retried on the next tick.
        console.error(
          `[sftp-poll] failed to ingest "${file.name}" from endpoint ${endpoint.id}: ${errorMessage(err)}`,
        );
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Admin endpoint test for inbound sftp-poll endpoints: connect, list the
 * remote directory, report the matching file count.
 */
export async function testPollEndpoint(endpoint: InboundSftpPollEndpoint): Promise<string> {
  const client = new SftpClient();
  try {
    await client.connect({
      host: endpoint.host,
      port: endpoint.port ?? 22,
      username: endpoint.username,
      password: endpoint.password,
      privateKey: endpoint.privateKey,
      readyTimeout: 15_000,
    });
    const listing = await client.list(endpoint.remoteDir);
    const pattern = endpoint.filePattern ? globToRegExp(endpoint.filePattern) : undefined;
    const matching = listing.filter(
      (item) => item.type === '-' && (!pattern || pattern.test(item.name)),
    );
    return `connected to ${endpoint.host}:${endpoint.port ?? 22}; ${matching.length} matching file(s) in ${endpoint.remoteDir}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}
