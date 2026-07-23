import fs from 'node:fs';
import path from 'node:path';
import type {
  DataFormat,
  FunnelConfig,
  FunnelMatch,
  Job,
  JobSource,
  StageName,
  StageRecord,
  TransformKind,
} from '@transformata/shared';
import { getTransform, listFunnels } from '../config-store.js';
import { deliver } from '../egress/deliver.js';
import { errorMessage } from '../errors.js';
import { parseDocument, serializeDocument } from '../formats.js';
import { evalJsonata, runJsonata } from '../jsonata-runner.js';
import { fromRoot } from '../root.js';
import { getSettings } from '../settings.js';

/**
 * The 8-stage pipeline (received → parsed → routed → normalized →
 * transformed → denormalized → serialized → delivered). Used by both the
 * queue worker (real jobs, deliver=true) and the admin funnel-test endpoint
 * (forced funnel, no job, deliver defaults to false).
 */

export interface PipelineOptions {
  jobId: string;
  source?: JobSource;
  /** Skip routing and force this funnel (admin funnel test). */
  forcedFunnel?: FunnelConfig;
  /** Actually deliver through the outbound endpoint. Default false. */
  deliver?: boolean;
  /** Persist the canonical document to data/canonical/<jobId>.json. Default false. */
  persistCanonical?: boolean;
  /** Called after every recorded stage (used to live-update the job row). */
  onProgress?: (update: {
    stages: StageRecord[];
    currentStage: StageName;
    funnel?: FunnelConfig;
  }) => void;
}

export interface PipelineResult {
  ok: boolean;
  stages: StageRecord[];
  funnel?: FunnelConfig;
  outputText?: string;
  error?: string;
  output?: Job['output'];
}

type ParseOutcome = { ok: true; doc: unknown } | { ok: false; error: string };

export async function runPipeline(
  rawText: string,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const stages: StageRecord[] = [];
  let funnel: FunnelConfig | undefined;

  const push = (record: StageRecord): void => {
    stages.push(record);
    try {
      opts.onProgress?.({ stages: [...stages], currentStage: record.stage, funnel });
    } catch (err) {
      console.warn(`[pipeline] onProgress callback failed: ${errorMessage(err)}`);
    }
  };
  const fail = (record: StageRecord): PipelineResult => {
    push(record);
    return { ok: false, stages, funnel, error: record.error };
  };

  /* -------------------------------- received ------------------------------- */
  {
    const startedAt = iso();
    const via = opts.source?.via ?? 'test';
    const fileName = opts.source?.fileName;
    push({
      stage: 'received',
      status: 'ok',
      startedAt,
      finishedAt: iso(),
      detail: `received ${Buffer.byteLength(rawText, 'utf8')} bytes via ${via}${
        fileName ? ` (file "${fileName}")` : ''
      }`,
      snapshot: truncateSnapshot(rawText),
    });
  }

  /* ---------------------------- parsed + routed ---------------------------- */
  let parsedDoc: unknown;

  if (opts.forcedFunnel) {
    funnel = opts.forcedFunnel;
    const startedAt = iso();
    const outcome = tryParse(rawText, funnel.inputFormat, funnel);
    if (!outcome.ok) {
      return fail({
        stage: 'parsed',
        status: 'error',
        startedAt,
        finishedAt: iso(),
        error: `failed to parse as ${funnel.inputFormat}: ${outcome.error}`,
      });
    }
    parsedDoc = outcome.doc;
    push({
      stage: 'parsed',
      status: 'ok',
      startedAt,
      finishedAt: iso(),
      detail: `parsed as ${funnel.inputFormat}`,
      snapshot: truncateSnapshot(parsedDoc),
    });
    const routeAt = iso();
    push({
      stage: 'routed',
      status: 'ok',
      startedAt: routeAt,
      finishedAt: iso(),
      detail: `routing skipped — funnel "${funnel.name}" forced (test)`,
    });
  } else {
    const parseStarted = iso();
    const sourceEndpointId = opts.source?.endpointId;
    const candidates = listFunnels()
      .filter((f) => f.enabled)
      .filter(
        (f) =>
          !f.inboundEndpointIds ||
          f.inboundEndpointIds.length === 0 ||
          (sourceEndpointId !== undefined && f.inboundEndpointIds.includes(sourceEndpointId)),
      )
      .sort((a, b) => a.priority - b.priority);

    if (candidates.length === 0) {
      // Nothing can claim this document; still record a best-effort parse.
      const generic = tryGenericParse(rawText);
      push({
        stage: 'parsed',
        status: generic ? 'ok' : 'error',
        startedAt: parseStarted,
        finishedAt: iso(),
        detail: generic ? `parsed as ${generic.format}` : undefined,
        error: generic ? undefined : 'document did not parse as json, csv, or xml',
        snapshot: generic ? truncateSnapshot(generic.doc) : undefined,
      });
      return fail({
        stage: 'routed',
        status: 'error',
        startedAt: iso(),
        finishedAt: iso(),
        error: 'no enabled funnels accept documents from this endpoint',
      });
    }

    // Parse once per (format, options) combination present among candidates.
    const cache = new Map<string, ParseOutcome>();
    const keyOf = (f: FunnelConfig): string =>
      `${f.inputFormat}|${JSON.stringify(f.inputOptions ?? {})}`;
    for (const f of candidates) {
      const key = keyOf(f);
      if (!cache.has(key)) cache.set(key, tryParse(rawText, f.inputFormat, f));
    }
    const parseFinished = iso();

    const parsedFormats = [
      ...new Set(
        candidates.filter((f) => cache.get(keyOf(f))?.ok).map((f) => f.inputFormat),
      ),
    ];
    if (parsedFormats.length === 0) {
      const attempted = [...new Set(candidates.map((f) => f.inputFormat))];
      const errors = attempted
        .map((fmt) => {
          const sample = candidates.find((f) => f.inputFormat === fmt);
          const outcome = sample ? cache.get(keyOf(sample)) : undefined;
          return outcome && !outcome.ok ? `${fmt}: ${outcome.error}` : `${fmt}: parse failed`;
        })
        .join('; ');
      return fail({
        stage: 'parsed',
        status: 'error',
        startedAt: parseStarted,
        finishedAt: parseFinished,
        error: `document did not parse in any candidate format — ${errors}`,
      });
    }

    // Evaluate match expressions in priority order; first match wins.
    const routeStarted = iso();
    let winner: FunnelConfig | undefined;
    let winnerDoc: unknown;
    let evaluated = 0;
    for (const f of candidates) {
      const outcome = cache.get(keyOf(f));
      if (!outcome?.ok) continue; // parse failure just rules these funnels out
      evaluated += 1;
      if (await matchesFunnel(f.match, outcome.doc)) {
        winner = f;
        winnerDoc = outcome.doc;
        break;
      }
    }

    const firstParsed = candidates.find((f) => cache.get(keyOf(f))?.ok);
    const firstParsedDoc =
      firstParsed && cache.get(keyOf(firstParsed))?.ok
        ? (cache.get(keyOf(firstParsed)) as { ok: true; doc: unknown }).doc
        : undefined;
    push({
      stage: 'parsed',
      status: 'ok',
      startedAt: parseStarted,
      finishedAt: parseFinished,
      detail: winner
        ? `parsed as ${winner.inputFormat}`
        : `parsed as ${parsedFormats.join(', ')}`,
      snapshot: truncateSnapshot(winner ? winnerDoc : firstParsedDoc),
    });

    if (!winner) {
      return fail({
        stage: 'routed',
        status: 'error',
        startedAt: routeStarted,
        finishedAt: iso(),
        error: `no funnel matched the document (${evaluated} candidate(s) evaluated)`,
      });
    }

    funnel = winner;
    parsedDoc = winnerDoc;
    push({
      stage: 'routed',
      status: 'ok',
      startedAt: routeStarted,
      finishedAt: iso(),
      detail: `matched funnel "${winner.name}" (priority ${winner.priority})`,
    });
  }

  /* --------------------- normalize / transform / denorm -------------------- */
  const mappingSteps: { stage: StageName; kind: TransformKind; id: string | null | undefined }[] =
    [
      { stage: 'normalized', kind: 'normalization', id: funnel.normalizationId },
      { stage: 'transformed', kind: 'transformation', id: funnel.transformationId },
      { stage: 'denormalized', kind: 'denormalization', id: funnel.denormalizationId },
    ];

  let doc = parsedDoc;
  for (const step of mappingSteps) {
    const startedAt = iso();
    if (!step.id) {
      push({
        stage: step.stage,
        status: 'skipped',
        startedAt,
        finishedAt: iso(),
        detail: `no ${step.kind} mapping configured (pass-through)`,
        snapshot: truncateSnapshot(doc),
      });
    } else {
      const transform = getTransform(step.id);
      if (!transform) {
        return fail({
          stage: step.stage,
          status: 'error',
          startedAt,
          finishedAt: iso(),
          error: `unknown ${step.kind} mapping "${step.id}"`,
        });
      }
      try {
        doc = await runJsonata(transform.jsonata, doc);
      } catch (err) {
        return fail({
          stage: step.stage,
          status: 'error',
          startedAt,
          finishedAt: iso(),
          error: `${step.kind} mapping "${transform.name}" failed: ${errorMessage(err)}`,
        });
      }
      push({
        stage: step.stage,
        status: 'ok',
        startedAt,
        finishedAt: iso(),
        detail: `applied ${step.kind} "${transform.name}"`,
        snapshot: truncateSnapshot(doc),
      });
    }

    // The document after the normalized stage IS the canonical — persist it
    // (also when normalization was skipped: the parsed doc is the canonical).
    if (step.stage === 'normalized' && opts.persistCanonical) {
      try {
        const dir = fromRoot('data', 'canonical');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `${opts.jobId}.json`),
          JSON.stringify(doc === undefined ? null : doc, null, 2),
          'utf8',
        );
      } catch (err) {
        console.warn(
          `[pipeline] failed to persist canonical for job ${opts.jobId}: ${errorMessage(err)}`,
        );
      }
    }
  }

  /* ------------------------------- serialized ------------------------------ */
  let outputText: string;
  {
    const startedAt = iso();
    try {
      outputText = serializeDocument(doc, funnel.outputFormat, funnel.outputOptions);
    } catch (err) {
      return fail({
        stage: 'serialized',
        status: 'error',
        startedAt,
        finishedAt: iso(),
        error: `serialization to ${funnel.outputFormat} failed: ${errorMessage(err)}`,
      });
    }
    push({
      stage: 'serialized',
      status: 'ok',
      startedAt,
      finishedAt: iso(),
      detail: `serialized to ${funnel.outputFormat} (${outputText.length} chars)`,
      snapshot: truncateSnapshot(outputText),
    });
  }

  /* -------------------------------- delivered ------------------------------ */
  const deliverStarted = iso();
  if (!opts.deliver) {
    push({
      stage: 'delivered',
      status: 'skipped',
      startedAt: deliverStarted,
      finishedAt: iso(),
      detail: 'delivery skipped (deliver flag not set)',
    });
    return { ok: true, stages, funnel, outputText };
  }

  try {
    const result = await deliver(outputText, funnel, opts.jobId);
    push({
      stage: 'delivered',
      status: 'ok',
      startedAt: deliverStarted,
      finishedAt: iso(),
      detail: `delivered to ${result.deliveredTo}`,
    });
    return {
      ok: true,
      stages,
      funnel,
      outputText,
      output: {
        endpointId: result.endpoint.id,
        endpointName: result.endpoint.name,
        deliveredTo: result.deliveredTo,
      },
    };
  } catch (err) {
    return fail({
      stage: 'delivered',
      status: 'error',
      startedAt: deliverStarted,
      finishedAt: iso(),
      error: `delivery failed: ${errorMessage(err)}`,
    });
  }
}

/* --------------------------------- helpers -------------------------------- */

function iso(): string {
  return new Date().toISOString();
}

function tryParse(
  rawText: string,
  format: DataFormat,
  funnel?: FunnelConfig,
): ParseOutcome {
  try {
    return { ok: true, doc: parseDocument(rawText, format, funnel?.inputOptions) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function tryGenericParse(rawText: string): { format: DataFormat; doc: unknown } | undefined {
  for (const format of ['json', 'xml', 'csv'] as const) {
    const outcome = tryParse(rawText, format);
    if (outcome.ok) return { format, doc: outcome.doc };
  }
  return undefined;
}

/**
 * Evaluate a funnel match against the parsed document. When `equals` is set,
 * the funnel matches when String(result) === equals; otherwise any truthy
 * result matches. Evaluation errors simply mean "no match".
 */
async function matchesFunnel(match: FunnelMatch, doc: unknown): Promise<boolean> {
  const result = await evalJsonata(match.expression, doc);
  if (!result.ok) return false;
  const output = result.output;
  if (match.equals !== undefined) {
    if (output === null || output === undefined) return false;
    return String(output) === match.equals;
  }
  return Boolean(output);
}

function truncateSnapshot(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text === undefined) return undefined;
  const limit = getSettings().snapshotLimitKb * 1024;
  return text.length > limit ? `${text.slice(0, limit)}\n… [truncated]` : text;
}
