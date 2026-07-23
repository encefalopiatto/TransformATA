#!/usr/bin/env node
/**
 * End-to-end smoke test: boots the server, pushes the two sample files
 * through their funnels via the inbound API, and verifies delivery.
 *
 *   node scripts/smoke.mjs            (uses server/dist if built, else tsx)
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PORT = process.env.SMOKE_PORT || '4199';
const BASE = `http://localhost:${PORT}`;
let failures = 0;
let server;

const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fn();
      if (res) return res;
    } catch {
      /* not ready yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function inbound(file, contentType) {
  const res = await fetch(`${BASE}/api/inbound/inbound-demo-api`, {
    method: 'POST',
    headers: { 'X-Api-Key': 'demo-key', 'Content-Type': contentType, 'X-File-Name': path.basename(file) },
    body: readFileSync(path.join(ROOT, file), 'utf8'),
  });
  const body = await res.json();
  ok(res.status === 202 && body.jobId, `inbound accepted ${file}`, `status ${res.status}`);
  return body.jobId;
}

async function awaitJob(jobId) {
  return waitFor(async () => {
    const res = await fetch(`${BASE}/api/monitor/jobs/${jobId}`);
    if (!res.ok) return null;
    const job = await res.json();
    return job.status === 'completed' || job.status === 'failed' ? job : null;
  }, 30_000, `job ${jobId}`);
}

try {
  // Clean outboxes so assertions are about this run.
  for (const dir of ['data/outbox/acme', 'data/outbox/globex']) {
    rmSync(path.join(ROOT, dir), { recursive: true, force: true });
  }

  const useDist = existsSync(path.join(ROOT, 'server/dist/index.js'));
  server = spawn(
    useDist ? 'node' : 'npx',
    useDist ? ['server/dist/index.js'] : ['tsx', 'server/src/index.ts'],
    { cwd: ROOT, env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  server.on('exit', (code) => {
    if (code !== null && code !== 0 && failures === 0) {
      console.error(`server exited early (code ${code})\n${serverLog}`);
      process.exit(1);
    }
  });

  await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, 30_000, 'health check');
  console.log(`server up on :${PORT} (${useDist ? 'dist' : 'tsx'})\n`);

  // 1) ACME CSV → XML funnel
  const acmeJob = await awaitJob(await inbound('samples/acme-orders.csv', 'text/csv'));
  ok(acmeJob.status === 'completed', 'ACME job completed', acmeJob.error ?? '');
  ok(acmeJob.funnelId === 'acme-orders-csv', 'ACME routed to CSV funnel', String(acmeJob.funnelId));
  const acmeFiles = existsSync(path.join(ROOT, 'data/outbox/acme')) ? readdirSync(path.join(ROOT, 'data/outbox/acme')) : [];
  ok(acmeFiles.some((f) => f.endsWith('.xml')), 'XML delivered to ACME outbox', acmeFiles.join(', '));
  if (acmeFiles[0]) {
    const xml = readFileSync(path.join(ROOT, 'data/outbox/acme', acmeFiles[0]), 'utf8');
    ok(xml.includes('ACME Industrial Corp.'), 'XML contains enriched partner name');
    ok(!xml.includes('TNT crate'), 'cancelled line filtered out of XML');
  }

  // 2) GLOBEX JSON → JSON funnel
  const globexJob = await awaitJob(await inbound('samples/globex-order.json', 'application/json'));
  ok(globexJob.status === 'completed', 'GLOBEX job completed', globexJob.error ?? '');
  const globexFiles = existsSync(path.join(ROOT, 'data/outbox/globex')) ? readdirSync(path.join(ROOT, 'data/outbox/globex')) : [];
  ok(globexFiles.some((f) => f.endsWith('.json')), 'JSON delivered to GLOBEX outbox', globexFiles.join(', '));
  if (globexFiles[0]) {
    const doc = JSON.parse(readFileSync(path.join(ROOT, 'data/outbox/globex', globexFiles[0]), 'utf8'));
    ok(doc.purchase_order?.order_value === 212.8, 'GLOBEX totals computed', String(doc.purchase_order?.order_value));
  }

  // 3) Unroutable file fails at the routing stage
  const badRes = await fetch(`${BASE}/api/inbound/inbound-demo-api`, {
    method: 'POST',
    headers: { 'X-Api-Key': 'demo-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'nobody claims me' }),
  });
  const badJob = await awaitJob((await badRes.json()).jobId);
  ok(badJob.status === 'failed', 'unroutable file fails', badJob.status);
  ok(badJob.currentStage === 'routed' || badJob.stages?.some((s) => s.stage === 'routed' && s.status === 'error'),
    'failure recorded at routing stage');

  // 4) Wrong API key rejected
  const authRes = await fetch(`${BASE}/api/inbound/inbound-demo-api`, {
    method: 'POST',
    headers: { 'X-Api-Key': 'wrong-key', 'Content-Type': 'text/plain' },
    body: 'x',
  });
  ok(authRes.status === 401, 'wrong API key rejected with 401', String(authRes.status));

  // 5) Monitor surface
  const stats = await (await fetch(`${BASE}/api/monitor/stats`)).json();
  ok(stats.total >= 3, 'monitor stats count jobs', JSON.stringify(stats));

  console.log(failures === 0 ? '\nSMOKE: all checks passed' : `\nSMOKE: ${failures} check(s) FAILED`);
} catch (err) {
  console.error(`\nSMOKE: fatal — ${err.message}`);
  failures++;
} finally {
  server?.kill('SIGTERM');
}
process.exit(failures === 0 ? 0 : 1);
