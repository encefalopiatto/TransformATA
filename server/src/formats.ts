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
      const delimiter = csv.delimiter ?? ',';
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
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix });
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
      try {
        return csvStringify(rows as Parameters<typeof csvStringify>[0], {
          header: true,
          delimiter: options?.csv?.delimiter ?? ',',
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

function csvRows(doc: unknown): unknown[] | null {
  if (Array.isArray(doc)) return doc;
  if (isPlainObject(doc) && Array.isArray(doc.rows)) return doc.rows;
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
