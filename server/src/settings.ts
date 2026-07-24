import fs from 'node:fs';
import type { AppSettings } from '@transformata/shared';
import { fromConfigRoot } from './root.js';

export type ResolvedSettings = Required<AppSettings>;

const DEFAULTS: ResolvedSettings = {
  httpPort: 4100,
  sftpPort: 4122,
  sftpServerEnabled: false,
  snapshotLimitKb: 256,
  workerConcurrency: 2,
  evaluateTimeoutMs: 10_000,
};

let cached: ResolvedSettings | undefined;

/** Load config/settings.json (all fields optional), apply env overrides. */
export function getSettings(): ResolvedSettings {
  if (cached) return cached;

  let fromFile: AppSettings = {};
  const file = fromConfigRoot('settings.json');
  if (fs.existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') {
        fromFile = parsed as AppSettings;
      }
    } catch (err) {
      console.warn(
        `[settings] failed to parse ${file}: ${err instanceof Error ? err.message : String(err)} — using defaults`,
      );
    }
  }

  const settings: ResolvedSettings = {
    httpPort: numberOr(fromFile.httpPort, DEFAULTS.httpPort),
    sftpPort: numberOr(fromFile.sftpPort, DEFAULTS.sftpPort),
    sftpServerEnabled:
      typeof fromFile.sftpServerEnabled === 'boolean'
        ? fromFile.sftpServerEnabled
        : DEFAULTS.sftpServerEnabled,
    snapshotLimitKb: numberOr(fromFile.snapshotLimitKb, DEFAULTS.snapshotLimitKb),
    workerConcurrency: numberOr(fromFile.workerConcurrency, DEFAULTS.workerConcurrency),
    evaluateTimeoutMs: numberOr(fromFile.evaluateTimeoutMs, DEFAULTS.evaluateTimeoutMs),
  };

  const envPort = process.env.PORT;
  if (envPort !== undefined && envPort.trim() !== '') {
    const port = Number(envPort);
    if (Number.isFinite(port) && port > 0) settings.httpPort = port;
    else console.warn(`[settings] ignoring invalid PORT env value "${envPort}"`);
  }

  const envSftp = process.env.SFTP_SERVER_ENABLED;
  if (envSftp === 'true') settings.sftpServerEnabled = true;
  else if (envSftp === 'false') settings.sftpServerEnabled = false;

  cached = settings;
  return cached;
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
