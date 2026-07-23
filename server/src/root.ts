import fs from 'node:fs';
import path from 'node:path';

/**
 * Locate the repository root. Resolution order:
 * 1. env TRANSFORMATA_ROOT
 * 2. walk up from process.cwd() to the nearest directory containing `config/`
 * 3. process.cwd()
 *
 * All `config/` and `data/` paths resolve from this root, so both
 * `npm start` (run at the repo root) and `npm run dev -w server` (run in
 * `server/`) behave identically.
 */
let cachedRoot: string | undefined;

export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  const fromEnv = process.env.TRANSFORMATA_ROOT;
  if (fromEnv && fromEnv.trim() !== '') {
    cachedRoot = path.resolve(fromEnv);
    return cachedRoot;
  }
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'config'))) {
      cachedRoot = dir;
      return cachedRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = process.cwd();
  return cachedRoot;
}

/** Resolve a path relative to the repo root (absolute paths pass through). */
export function fromRoot(...segments: string[]): string {
  return path.resolve(repoRoot(), ...segments);
}
