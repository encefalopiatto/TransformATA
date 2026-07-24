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
 * Locate the live config directory (settings.json + endpoints/funnels/
 * mapping subdirectories). Default: `<repoRoot>/config`. When
 * TRANSFORMATA_CONFIG_DIR is set (e.g. pointing into a persistent disk on
 * Render), that directory is used instead and is seeded once from the repo's
 * `config/` tree on first boot — see `ensureSeededFromRepo`.
 */
let cachedConfigRoot: string | undefined;

export function configRoot(): string {
  if (cachedConfigRoot) return cachedConfigRoot;
  const fromEnv = process.env.TRANSFORMATA_CONFIG_DIR;
  if (!fromEnv || fromEnv.trim() === '') {
    cachedConfigRoot = fromRoot('config');
    return cachedConfigRoot;
  }
  const dir = path.resolve(fromEnv.trim());
  ensureSeededFromRepo(dir);
  cachedConfigRoot = dir;
  return cachedConfigRoot;
}

/** Resolve a path relative to the live config directory. */
export function fromConfigRoot(...segments: string[]): string {
  return path.resolve(configRoot(), ...segments);
}

const SEED_MARKER = '.seeded-from-repo';

/**
 * First-boot seeding for an external config directory: copy the repo's
 * `config/` tree into `dir`, never overwriting files that already exist,
 * then drop a marker file so later boots leave the directory alone entirely
 * (the external directory is the source of truth from then on — deletions
 * made through the admin panel must not be resurrected by the repo seeds on
 * the next deploy). Deleting the marker re-runs the non-destructive copy on
 * the next boot, which is the supported way to pick up new repo seed files.
 */
function ensureSeededFromRepo(dir: string): void {
  const seedSrc = fromRoot('config');
  if (dir === path.resolve(seedSrc)) return; // pointing at the repo config — nothing to seed
  const marker = path.join(dir, SEED_MARKER);
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(seedSrc)) {
    fs.cpSync(seedSrc, dir, { recursive: true, force: false, errorOnExist: false });
    console.log(`[config] seeded ${dir} from ${seedSrc} (first boot)`);
  }
  fs.writeFileSync(
    marker,
    `Seeded from ${seedSrc} at ${new Date().toISOString()}.\n` +
      `This directory is now the source of truth for TransformATA config.\n` +
      `Delete this file to re-copy missing repo seed files on next boot (existing files are never overwritten).\n`,
    'utf8',
  );
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
