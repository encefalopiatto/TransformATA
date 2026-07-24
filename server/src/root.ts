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
  // Fallback: nothing containing config/ was found walking up. Boot from the
  // current working directory, but warn loudly — a healthy-but-empty server
  // booted from the wrong cwd is a confusing failure mode.
  cachedRoot = process.cwd();
  if (!fs.existsSync(path.join(cachedRoot, 'config'))) {
    console.warn(
      `[root] WARNING: no "config/" directory found walking up from ${process.cwd()}. ` +
        `Falling back to ${cachedRoot}; the server will start with NO endpoints, funnels, ` +
        `or mappings. Set TRANSFORMATA_ROOT to your project root to fix this.`,
    );
  }
  return cachedRoot;
}

/** Resolve a path relative to the repo root (absolute paths pass through). */
export function fromRoot(...segments: string[]): string {
  return path.resolve(repoRoot(), ...segments);
}

/**
 * Resolve a directory path relative to the repo root, ensuring the result
 * stays within that root (defence against path traversal / absolute-path
 * escapes on the unauthenticated admin API). Throws a plain Error when the
 * path escapes the root, UNLESS `TRANSFORMATA_ALLOW_ABSOLUTE_OUTBOX === 'true'`
 * (opt-in for self-hosted deployments that intentionally write outside the
 * project). Uses `path.relative` so sibling-prefix paths (e.g. `/root` vs
 * `/root-evil`) are not mistaken for containment.
 */
export function resolveContainedDir(dirPath: string): string {
  const resolved = fromRoot(dirPath);
  if (process.env.TRANSFORMATA_ALLOW_ABSOLUTE_OUTBOX === 'true') return resolved;
  const root = repoRoot();
  const rel = path.relative(root, resolved);
  const escapes = rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
  if (escapes) {
    throw new Error(
      `directory path "${dirPath}" resolves outside the project root (${root}); ` +
        `set TRANSFORMATA_ALLOW_ABSOLUTE_OUTBOX=true to allow paths outside the project`,
    );
  }
  return resolved;
}
