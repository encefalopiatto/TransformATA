import { customAlphabet } from 'nanoid';

const LOWER_ALNUM = '0123456789abcdefghijklmnopqrstuvwxyz';

const shortSuffix = customAlphabet(LOWER_ALNUM, 4);
const jobIdAlphabet = customAlphabet(LOWER_ALNUM, 12);

/** Lowercase, dash-separated slug of a display name. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'item';
}

/** Config object id: slugified name + short random suffix, e.g. `acme-orders-x7k2`. */
export function generateConfigId(name: string): string {
  return `${slugify(name)}-${shortSuffix()}`;
}

/** Job id: 12-char lowercase alphanumeric. */
export function generateJobId(): string {
  return jobIdAlphabet();
}
