import { EventEmitter } from 'node:events';
import type {
  Job,
  JobSource,
  JobStatus,
  JobSummary,
  MonitorStats,
  StageName,
  StageRecord,
} from '@transformata/shared';
import { errorMessage } from '../errors.js';
import { generateJobId } from '../ids.js';
import { runPipeline } from '../pipeline/engine.js';
import { getSettings } from '../settings.js';
import { getDb, type JobRow } from './db.js';

/** In-process event bus: emits ('job', JobSummary) on every create/update. */
export const jobBus = new EventEmitter();
jobBus.setMaxListeners(100);

const JOB_STATUSES: JobStatus[] = ['queued', 'processing', 'completed', 'failed'];

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as string[]).includes(value);
}

/* ------------------------------ row mapping ----------------------------- */

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as JobStatus,
    source: safeParse<JobSource>(row.source_json) ?? { endpointId: 'unknown', via: 'api' },
    funnelId: row.funnel_id,
    funnelName: row.funnel_name ?? undefined,
    currentStage: (row.current_stage ?? undefined) as StageName | undefined,
    stages: safeParse<StageRecord[]>(row.stages_json) ?? [],
    error: row.error ?? undefined,
    attempts: row.attempts,
    output: safeParse<Job['output']>(row.output_json ?? 'null') ?? undefined,
  };
}

export function toSummary(job: Job): JobSummary {
  return {
    ...job,
    stages: job.stages.map(({ snapshot: _snapshot, ...rest }) => rest),
  };
}

function safeParse<T>(text: string | null): T | undefined {
  if (text === null) return undefined;
  try {
    const parsed = JSON.parse(text) as T | null;
    return parsed === null ? undefined : parsed;
  } catch {
    return undefined;
  }
}

function iso(): string {
  return new Date().toISOString();
}

function emitJob(job: Job): void {
  jobBus.emit('job', toSummary(job));
}

/* -------------------------------- queue API ------------------------------ */

export function createJob(source: JobSource, rawPayload: string): Job {
  const db = getDb();
  const id = generateJobId();
  const now = iso();
  db.prepare(
    `INSERT INTO jobs (id, created_at, updated_at, status, source_json, stages_json, attempts, raw_payload)
     VALUES (?, ?, ?, 'queued', ?, '[]', 0, ?)`,
  ).run(id, now, now, JSON.stringify(source), rawPayload);
  const job = getJob(id);
  if (!job) throw new Error(`job ${id} vanished after insert`);
  emitJob(job);
  return job;
}

/**
 * Atomically claim the oldest queued job and mark it processing. A single
 * UPDATE ... RETURNING statement, so concurrent workers can never claim the
 * same job (SQLite statements are atomic).
 */
export function claimNextQueued(): { job: Job; raw: string } | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1)
       RETURNING id, raw_payload`,
    )
    .get(iso()) as unknown as Pick<JobRow, 'id' | 'raw_payload'> | undefined;
  if (!row) return undefined;
  const job = getJob(row.id);
  if (!job) return undefined;
  emitJob(job);
  return { job, raw: row.raw_payload ?? '' };
}

export interface JobPatch {
  status?: JobStatus;
  funnelId?: string | null;
  funnelName?: string | null;
  currentStage?: StageName;
  stages?: StageRecord[];
  error?: string | null;
  output?: Job['output'] | null;
}

export function updateJob(id: string, patch: JobPatch): Job | undefined {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [iso()];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.funnelId !== undefined) {
    sets.push('funnel_id = ?');
    params.push(patch.funnelId);
  }
  if (patch.funnelName !== undefined) {
    sets.push('funnel_name = ?');
    params.push(patch.funnelName);
  }
  if (patch.currentStage !== undefined) {
    sets.push('current_stage = ?');
    params.push(patch.currentStage);
  }
  if (patch.stages !== undefined) {
    sets.push('stages_json = ?');
    params.push(JSON.stringify(patch.stages));
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    params.push(patch.error);
  }
  if (patch.output !== undefined) {
    sets.push('output_json = ?');
    params.push(patch.output === null ? null : JSON.stringify(patch.output));
  }
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  const job = getJob(id);
  if (job) emitJob(job);
  return job;
}

export function getJob(id: string): Job | undefined {
  const row = getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  return row ? rowToJob(row) : undefined;
}

export function getJobRawPayload(id: string): string | null {
  const row = getDb().prepare(`SELECT raw_payload FROM jobs WHERE id = ?`).get(id) as
    | Pick<JobRow, 'raw_payload'>
    | undefined;
  return row ? row.raw_payload : null;
}

export interface ListJobsFilter {
  status?: JobStatus;
  funnelId?: string;
  limit: number;
  offset: number;
}

export function listJobs(filter: ListJobsFilter): { jobs: JobSummary[]; total: number } {
  const db = getDb();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.funnelId) {
    where.push('funnel_id = ?');
    params.push(filter.funnelId);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM jobs ${whereSql}`).get(...params) as {
    c: number;
  };
  const rows = db
    .prepare(
      `SELECT * FROM jobs ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as unknown as JobRow[];
  return { jobs: rows.map((r) => toSummary(rowToJob(r))), total: totalRow.c };
}

export function stats(): MonitorStats {
  const rows = getDb()
    .prepare(`SELECT status, COUNT(*) AS c FROM jobs GROUP BY status`)
    .all() as { status: string; c: number }[];
  const result: MonitorStats = { queued: 0, processing: 0, completed: 0, failed: 0, total: 0 };
  for (const row of rows) {
    if (isJobStatus(row.status)) result[row.status] = row.c;
    result.total += row.c;
  }
  return result;
}

/* ------------------------------ worker pool ------------------------------ */

/**
 * Start `workerConcurrency` pollers (250ms interval) that claim queued jobs
 * and run them through the pipeline engine. Returns a stop function.
 */
export function startWorkers(): () => void {
  const { workerConcurrency } = getSettings();
  const timers: NodeJS.Timeout[] = [];
  for (let i = 0; i < workerConcurrency; i++) {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      let claimed: { job: Job; raw: string } | undefined;
      try {
        claimed = claimNextQueued();
      } catch (err) {
        console.error(`[worker ${i}] failed to claim job: ${errorMessage(err)}`);
        return;
      }
      if (!claimed) return;
      busy = true;
      void processJob(claimed).finally(() => {
        busy = false;
      });
    }, 250);
    timer.unref();
    timers.push(timer);
  }
  console.log(`[queue] started ${workerConcurrency} pipeline worker(s)`);
  return () => {
    for (const t of timers) clearInterval(t);
  };
}

async function processJob(claimed: { job: Job; raw: string }): Promise<void> {
  const { job, raw } = claimed;
  try {
    const result = await runPipeline(raw, {
      jobId: job.id,
      source: job.source,
      deliver: true,
      persistCanonical: true,
      onProgress: (update) => {
        const patch: JobPatch = {
          stages: update.stages,
          currentStage: update.currentStage,
        };
        if (update.funnel) {
          patch.funnelId = update.funnel.id;
          patch.funnelName = update.funnel.name;
        }
        updateJob(job.id, patch);
      },
    });
    updateJob(job.id, {
      status: result.ok ? 'completed' : 'failed',
      stages: result.stages,
      currentStage: result.stages.at(-1)?.stage,
      funnelId: result.funnel ? result.funnel.id : null,
      funnelName: result.funnel ? result.funnel.name : null,
      error: result.error ?? null,
      output: result.output ?? null,
    });
  } catch (err) {
    // Top-level safety net: the engine should not throw, but a crash must
    // never take down the worker loop or leave the job stuck in processing.
    console.error(`[worker] job ${job.id} crashed:`, err);
    try {
      updateJob(job.id, { status: 'failed', error: errorMessage(err) });
    } catch (updateErr) {
      console.error(`[worker] failed to mark job ${job.id} failed:`, updateErr);
    }
  }
}
