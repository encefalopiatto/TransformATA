/**
 * TransformATA shared type contracts.
 *
 * These types are the single source of truth used by the server (pipeline,
 * config store, REST API) and the web app (admin panel, monitor, visual
 * editor). Config files on disk under `config/` serialize these shapes 1:1.
 */

/* ============================== Formats ============================== */

export type DataFormat = 'json' | 'csv' | 'xml';

export interface CsvOptions {
  /** Column delimiter. Default: "," */
  delimiter?: string;
  /** Whether the first row contains column names. Default: true */
  hasHeaders?: boolean;
}

export interface XmlOptions {
  /** Element name to wrap the document in when serializing. Default: "root" */
  rootName?: string;
  /** Prefix used for XML attributes when parsing/serializing. Default: "@_" */
  attributePrefix?: string;
}

export interface FormatOptions {
  csv?: CsvOptions;
  xml?: XmlOptions;
}

/**
 * Parsing conventions (implemented by the server, relied on by mappings):
 * - json: document used as-is.
 * - csv:  parsed to `{ "rows": [ { "<col>": "<string value>", ... }, ... ] }`.
 *         All cell values are strings; use $number() in mappings to cast.
 * - xml:  parsed with fast-xml-parser, attributes prefixed with `@_`.
 *
 * Serialization conventions:
 * - json: pretty-printed with 2-space indent.
 * - csv:  accepts an array of flat objects, or an object with a `rows` array.
 * - xml:  document is wrapped in `<rootName>` (default "root") unless it is
 *         an object with exactly one top-level key, which is used as-is.
 */

/* ============================= Endpoints ============================= */

export type EndpointDirection = 'inbound' | 'outbound';

interface EndpointBase {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean; // default true
}

/** Inbound: HTTP push. Files are POSTed to /api/inbound/:endpointId with X-Api-Key. */
export interface InboundApiEndpoint extends EndpointBase {
  direction: 'inbound';
  kind: 'api';
  apiKey: string;
}

/**
 * Inbound: embedded SFTP server (self-hosted deployments only; requires a
 * raw TCP port, so not available on Render web services). Each endpoint is
 * an SFTP user; files uploaded by that user create jobs.
 */
export interface InboundSftpServerEndpoint extends EndpointBase {
  direction: 'inbound';
  kind: 'sftp';
  username: string;
  password: string;
}

/**
 * Inbound: SFTP polling client. The app connects OUT to a remote SFTP server
 * on an interval and ingests new files. Works on Render free tier.
 */
export interface InboundSftpPollEndpoint extends EndpointBase {
  direction: 'inbound';
  kind: 'sftp-poll';
  host: string;
  port?: number; // default 22
  username: string;
  password?: string;
  privateKey?: string; // PEM
  remoteDir: string;
  /** Simple glob on file name, e.g. "*.csv". Default: all files. */
  filePattern?: string;
  /** Default: 60 */
  pollIntervalSec?: number;
  /** What to do with the remote file after successful ingestion. Default: "move" */
  afterFetch?: 'delete' | 'move';
  /** Remote dir to move processed files into (when afterFetch = "move"). Default: `<remoteDir>/processed` */
  moveToDir?: string;
}

/** Outbound: HTTP push to a partner/webhook. */
export interface OutboundApiEndpoint extends EndpointBase {
  direction: 'outbound';
  kind: 'api';
  url: string;
  method?: 'POST' | 'PUT'; // default POST
  headers?: Record<string, string>;
}

/** Outbound: upload to a remote SFTP server. */
export interface OutboundSftpEndpoint extends EndpointBase {
  direction: 'outbound';
  kind: 'sftp';
  host: string;
  port?: number; // default 22
  username: string;
  password?: string;
  privateKey?: string; // PEM
  remoteDir: string;
}

/** Outbound: write to a local directory (testing / self-hosted drop folder). */
export interface OutboundDirectoryEndpoint extends EndpointBase {
  direction: 'outbound';
  kind: 'directory';
  path: string;
}

export type InboundEndpoint =
  | InboundApiEndpoint
  | InboundSftpServerEndpoint
  | InboundSftpPollEndpoint;

export type OutboundEndpoint =
  | OutboundApiEndpoint
  | OutboundSftpEndpoint
  | OutboundDirectoryEndpoint;

export type Endpoint = InboundEndpoint | OutboundEndpoint;

/* ====================== Transforms (mappings) ======================== */

export type TransformKind = 'normalization' | 'transformation' | 'denormalization';

/**
 * A stored mapping. `jsonata` is what the pipeline executes. When the mapping
 * was built with the visual editor, `graph` holds the node graph and
 * `jsonata` is the compiled output of that graph.
 */
export interface TransformConfig {
  id: string;
  name: string;
  kind: TransformKind;
  description?: string;
  jsonata: string;
  graph?: TGraph | null;
  /** Sample input document used for live preview in the editor. */
  sampleInput?: unknown;
  updatedAt?: string;
}

/* ============================== Funnels ============================== */

/**
 * How a funnel claims an inbound document. `expression` is a JSONata
 * expression evaluated against the *parsed* document (see parsing
 * conventions). If `equals` is set the funnel matches when
 * String(result) === equals; otherwise any truthy result matches.
 */
export interface FunnelMatch {
  expression: string;
  equals?: string;
}

export interface FunnelConfig {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  /** Lower number = evaluated first. */
  priority: number;
  match: FunnelMatch;
  inputFormat: DataFormat;
  inputOptions?: FormatOptions;
  /** Each stage is optional; when null/undefined the stage is a pass-through. */
  normalizationId?: string | null;
  transformationId?: string | null;
  denormalizationId?: string | null;
  outputFormat: DataFormat;
  outputOptions?: FormatOptions;
  outputEndpointId: string;
  /**
   * Restrict which inbound endpoints this funnel accepts documents from.
   * Empty/undefined = any inbound endpoint.
   */
  inboundEndpointIds?: string[];
  /** Template for the delivered file name. Supports {jobId}, {date}, {time}, {funnelId}. */
  outputFileName?: string;
}

/* ================================ Jobs ================================ */

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type StageName =
  | 'received'
  | 'parsed'
  | 'routed'
  | 'normalized'
  | 'transformed'
  | 'denormalized'
  | 'serialized'
  | 'delivered';

export const STAGE_ORDER: StageName[] = [
  'received',
  'parsed',
  'routed',
  'normalized',
  'transformed',
  'denormalized',
  'serialized',
  'delivered',
];

export interface StageRecord {
  stage: StageName;
  status: 'ok' | 'error' | 'skipped';
  startedAt: string;
  finishedAt: string;
  /** Human-readable note, e.g. "matched funnel ACME Orders (CSV)". */
  detail?: string;
  error?: string;
  /**
   * JSON-stringified snapshot of the data after this stage (or raw text for
   * received/serialized), truncated server-side to the configured limit.
   */
  snapshot?: string;
}

export interface JobSource {
  endpointId: string;
  endpointName?: string;
  via: 'api' | 'sftp' | 'sftp-poll' | 'retry' | 'test';
  fileName?: string;
  /** Job id this job was retried from, if any. */
  retryOf?: string;
}

export interface Job {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  source: JobSource;
  funnelId?: string | null;
  funnelName?: string;
  currentStage?: StageName;
  stages: StageRecord[];
  error?: string;
  attempts: number;
  output?: {
    endpointId: string;
    endpointName?: string;
    /** e.g. delivered file path, URL + response status */
    deliveredTo?: string;
  };
}

/** Job list item as returned by list/stream APIs (snapshots stripped). */
export type JobSummary = Omit<Job, 'stages'> & {
  stages: Omit<StageRecord, 'snapshot'>[];
};

export interface MonitorStats {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
}

/* ========================= Visual graph model ========================= */

export type GraphNodeType =
  | 'input' // the source document ($$)
  | 'item' // current item within a map/filter ($)
  | 'path' // navigate a path, optionally relative to an input
  | 'literal' // constant value
  | 'object' // build an object from wired keys
  | 'array' // build an array from wired slots
  | 'map' // map an array through a sub-expression
  | 'filter' // filter an array by a predicate
  | 'stringOp'
  | 'numberOp'
  | 'compare'
  | 'condition' // if/then/else
  | 'lookup' // static lookup table
  | 'sort'
  | 'distinct'
  | 'raw' // hand-written JSONata escape hatch
  | 'output'; // the single result node

export interface TGraphNode {
  id: string;
  type: GraphNodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface TGraphEdge {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  /** Which input of the target node this edge feeds; see docs/GRAPH_NODES.md */
  targetHandle?: string | null;
}

export interface TGraph {
  nodes: TGraphNode[];
  edges: TGraphEdge[];
}

/* --- Per-node `data` payloads (see docs/GRAPH_NODES.md for emit rules) --- */

export interface PathNodeData {
  path: string;
}
export interface LiteralNodeData {
  value: unknown;
}
export interface ObjectNodeData {
  keys: string[];
}
export interface ArrayNodeData {
  count: number;
}

export type StringOp =
  | 'concat'
  | 'uppercase'
  | 'lowercase'
  | 'trim'
  | 'substring'
  | 'replace'
  | 'split'
  | 'join'
  | 'toString';

export interface StringOpNodeData {
  op: StringOp;
  /** concat: number of `in:<i>` handles. Default 2. */
  count?: number;
  /** substring */
  start?: number;
  length?: number;
  /** replace */
  pattern?: string;
  replacement?: string;
  /** split / join */
  separator?: string;
}

export type NumberOp =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'modulo'
  | 'round'
  | 'floor'
  | 'ceil'
  | 'abs'
  | 'sum'
  | 'max'
  | 'min'
  | 'average'
  | 'count'
  | 'toNumber';

export interface NumberOpNodeData {
  op: NumberOp;
  /** round */
  precision?: number;
}

export type CompareOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'and'
  | 'or'
  | 'not'
  | 'in';

export interface CompareNodeData {
  op: CompareOp;
}

export interface LookupNodeData {
  table: Record<string, string>;
  default?: string;
}

export interface SortNodeData {
  /** Path within each item to sort by; empty = sort values directly. */
  by?: string;
  descending?: boolean;
}

export interface RawNodeData {
  expression: string;
}

/* ======================= Graph compiler results ======================= */

export interface GraphIssue {
  nodeId?: string;
  message: string;
}

export type CompileResult =
  | { ok: true; expression: string; warnings: GraphIssue[] }
  | { ok: false; errors: GraphIssue[] };

/* ======================== JSONata evaluation ========================== */

export type EvalResult =
  | { ok: true; output: unknown }
  | { ok: false; error: string };

/* ========================== Admin API shapes ========================== */

export interface TestExpressionRequest {
  expression: string;
  input: unknown;
}

export interface TestFunnelRequest {
  fileName?: string;
  /** Raw file content (JSON/CSV/XML text). */
  content: string;
  /** When true, actually deliver to the outbound endpoint. Default: false. */
  deliver?: boolean;
}

export interface TestFunnelResponse {
  ok: boolean;
  stages: StageRecord[];
  /** Final serialized output text (present when serialization succeeded). */
  outputText?: string;
}

export interface TestEndpointResponse {
  ok: boolean;
  detail: string;
}

/** Full config bundle for export/import (Render free tier has no persistent disk). */
export interface ConfigBundle {
  version: 1;
  exportedAt: string;
  endpoints: Endpoint[];
  funnels: FunnelConfig[];
  transforms: TransformConfig[];
}

export interface ApiError {
  error: string;
}

/* ============================= Settings =============================== */

export interface AppSettings {
  /** HTTP port; overridden by process.env.PORT (Render). Default 4100. */
  httpPort?: number;
  /** Embedded SFTP server port. Default 4122. */
  sftpPort?: number;
  /** Enable embedded SFTP server; overridden by env SFTP_SERVER_ENABLED. Default false. */
  sftpServerEnabled?: boolean;
  /** Max snapshot size stored per stage, in KB. Default 256. */
  snapshotLimitKb?: number;
  /** Parallel pipeline workers. Default 2. */
  workerConcurrency?: number;
  /** JSONata evaluation timeout in ms. Default 10000. */
  evaluateTimeoutMs?: number;
}
