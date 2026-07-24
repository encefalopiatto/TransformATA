import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fromRoot } from '../root.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  status        TEXT NOT NULL,
  source_json   TEXT NOT NULL,
  funnel_id     TEXT,
  funnel_name   TEXT,
  current_stage TEXT,
  stages_json   TEXT NOT NULL DEFAULT '[]',
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  raw_payload   TEXT,
  output_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
`;

export interface JobRow {
  id: string;
  created_at: string;
  updated_at: string;
  status: string;
  source_json: string;
  funnel_id: string | null;
  funnel_name: string | null;
  current_stage: string | null;
  stages_json: string;
  error: string | null;
  attempts: number;
  raw_payload: string | null;
  output_json: string | null;
}

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = fromRoot('data', 'transformata.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // node:sqlite (built into Node >= 22.13) — no native module to compile.
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  reclaimOrphanedJobs(db);
  return db;
}

/**
 * Re-queue jobs left in 'processing' by a previous run. Nothing else resets
 * in-flight jobs, so without this a redeploy / OOM / crash strands them in
 * 'processing' forever (they are never re-claimed by a worker). Run once at
 * boot, right after the schema is ensured.
 */
function reclaimOrphanedJobs(database: DatabaseSync): void {
  try {
    const result = database
      .prepare(`UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'processing'`)
      .run(new Date().toISOString());
    const requeued = Number(result.changes ?? 0);
    if (requeued > 0) {
      console.log(`[queue] re-queued ${requeued} orphaned job(s) stuck in 'processing' at boot`);
    }
  } catch (err) {
    console.warn(
      `[queue] failed to reclaim orphaned jobs at boot: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
