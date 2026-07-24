import { parse as csvParse } from 'csv-parse/sync';
import { stringify as csvStringify } from 'csv-stringify/sync';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import type { DataFormat, FormatOptions } from '@transformata/shared';
import { errorMessage } from './errors.js';

/**
 * Parse raw text into a JS document following the conventions documented in
 * shared/src/types.ts:
 * - json: document used as-is.
 * - csv:  `{ rows: [ { "<col>": "<string>" , ... }, ... ] }` — all cells strings.
 * - xml:  fast-xml-parser, attributes prefixed (default `@_`).
 */
export function parseDocument(text: string, format: DataFormat, options?: FormatOptions): unknown {
  switch (format) {
    case 'json': {
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        throw new Error(`invalid JSON: ${errorMessage(err)}`);
      }
    }
    case 'csv': {
      const csv = options?.csv ?? {};
      const delimiter = normalizeDelimiter(csv.delimiter);
      try {
        if (csv.hasHeaders === false) {
          const raw = csvParse(text, {
            columns: false,
            skip_empty_lines: true,
            bom: true,
            trim: true,
            delimiter,
          }) as string[][];
          const rows = raw.map((cells) =>
            Object.fromEntries(cells.map((value, i) => [`col${i + 1}`, value])),
          );
          return { rows };
        }
        const rows = csvParse(text, {
          columns: true,
          skip_empty_lines: true,
          bom: true,
          trim: true,
          delimiter,
        }) as Record<string, string>[];
        return { rows };
      } catch (err) {
        throw new Error(`invalid CSV: ${errorMessage(err)}`);
      }
    }
    case 'xml': {
      const attributeNamePrefix = options?.xml?.attributePrefix ?? '@_';
      const validation = XMLValidator.validate(text);
      if (validation !== true) {
        throw new Error(`invalid XML: ${validation.err.msg} (line ${validation.err.line})`);
      }
      try {
        // parseTagValue/parseAttributeValue false: keep ALL leaf values as
        // strings. Otherwise "<id>00123</id>" becomes the number 123 (leading
        // zeros dropped) — mangling identifiers/refs and breaking string-match
        // expressions. Mappings cast explicitly with $number() when needed.
        const parser = new XMLParser({
          ignoreAttributes: false,
          attributeNamePrefix,
          parseTagValue: false,
          parseAttributeValue: false,
        });
        return parser.parse(text) as unknown;
      } catch (err) {
        throw new Error(`invalid XML: ${errorMessage(err)}`);
      }
    }
  }
}

/**
 * Serialize a document to text:
 * - json: pretty-printed, 2-space indent.
 * - csv:  accepts an array of flat objects or an object with a `rows` array.
 * - xml:  wrapped in `<rootName>` (default "root") unless the document is an
 *         object with exactly one top-level key, which is used as-is.
 */
export function serializeDocument(
  doc: unknown,
  format: DataFormat,
  options?: FormatOptions,
): string {
  switch (format) {
    case 'json': {
      return JSON.stringify(doc === undefined ? null : doc, null, 2);
    }
    case 'csv': {
      const rows = csvRows(doc);
      if (rows === null) {
        throw new Error(
          'CSV serialization expects an array of flat objects or an object with a "rows" array',
        );
      }
      // Infer columns from the UNION of keys across ALL rows (first-seen
      // order), not just the first row — otherwise columns that are absent
      // from the first row are silently dropped from every row.
      const columns = unionColumns(rows);
      try {
        return csvStringify(rows as Parameters<typeof csvStringify>[0], {
          header: true,
          delimiter: normalizeDelimiter(options?.csv?.delimiter),
          ...(columns.length > 0 ? { columns } : {}),
        });
      } catch (err) {
        throw new Error(`CSV serialization failed: ${errorMessage(err)}`);
      }
    }
    case 'xml': {
      const rootName = options?.xml?.rootName ?? 'root';
      const attributeNamePrefix = options?.xml?.attributePrefix ?? '@_';
      const wrapped =
        isPlainObject(doc) && Object.keys(doc).length === 1 ? doc : { [rootName]: doc ?? null };
      try {
        const builder = new XMLBuilder({
          ignoreAttributes: false,
          attributeNamePrefix,
          format: true,
        });
        return String(builder.build(wrapped));
      } catch (err) {
        throw new Error(`XML serialization failed: ${errorMessage(err)}`);
      }
    }
  }
}

/**
 * An empty or whitespace-only delimiter reaches csv-parse/csv-stringify and
 * throws ("Invalid delimiter"), failing every job for that funnel. Treat it as
 * the default ",".
 */
function normalizeDelimiter(delimiter: string | undefined): string {
  return typeof delimiter === 'string' && delimiter.trim() !== '' ? delimiter : ',';
}

/** Union of object keys across all rows, preserving first-seen order. */
function unionColumns(rows: unknown[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    if (isPlainObject(row)) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }
  }
  return columns;
}

function csvRows(doc: unknown): unknown[] | null {
  if (Array.isArray(doc)) return doc;
  if (isPlainObject(doc) && Array.isArray(doc.rows)) return doc.rows;
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
