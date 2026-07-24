import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { Server as SshServer } from 'ssh2';
import { listEndpoints, listFunnels, listTransforms } from './config-store.js';
import { createApp } from './http/app.js';
import { startSftpPollers } from './ingress/sftp-poll.js';
import { startSftpServer } from './ingress/sftp-server.js';
import { closeDb, getDb } from './queue/db.js';
import { startWorkers } from './queue/queue.js';
import { configRoot, fromRoot, repoRoot } from './root.js';
import { getSettings } from './settings.js';

function ensureDataDirs(): void {
  for (const dir of ['data', 'data/canonical', 'data/sftp-in', 'data/outbox']) {
    fs.mkdirSync(fromRoot(dir), { recursive: true });
  }
}

function main(): void {
  const settings = getSettings();
  ensureDataDirs();
  getDb(); // open + migrate

  const stopWorkers = startWorkers();
  const stopPollers = startSftpPollers();

  let sftpServer: SshServer | undefined;
  if (settings.sftpServerEnabled) {
    sftpServer = startSftpServer();
  }

  const app = createApp();
  const httpServer: HttpServer = app.listen(settings.httpPort, '0.0.0.0', () => {
    const endpoints = listEndpoints();
    const funnels = listFunnels();
    const transforms = listTransforms();
    console.log('TransformATA server started');
    console.log(`  root:        ${repoRoot()}`);
    console.log(`  config dir:  ${configRoot()}`);
    console.log(`  http:        http://0.0.0.0:${settings.httpPort}`);
    console.log(
      `  sftp server: ${settings.sftpServerEnabled ? `enabled on port ${settings.sftpPort}` : 'disabled'}`,
    );
    console.log(`  workers:     ${settings.workerConcurrency}`);
    console.log(
      `  config:      ${endpoints.length} endpoint(s), ${funnels.length} funnel(s), ${transforms.length} transform(s)`,
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] received ${signal}, shutting down...`);
    stopWorkers();
    stopPollers();
    sftpServer?.close();
    httpServer.close(() => {
      closeDb();
      process.exit(0);
    });
    // Open SSE connections keep the server alive — force-exit after a grace period.
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
