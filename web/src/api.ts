/**
 * Typed API client for the TransformATA server (same-origin `/api/...`).
 * Route shapes follow docs/API.md; types come from @transformata/shared.
 */
import type {
  ConfigBundle,
  Endpoint,
  EndpointDirection,
  EvalResult,
  FunnelConfig,
  Job,
  JobStatus,
  JobSummary,
  MonitorStats,
  TestEndpointResponse,
  TestExpressionRequest,
  TestFunnelRequest,
  TestFunnelResponse,
  TransformConfig,
  TransformKind,
} from '@transformata/shared';

/** Distributive Omit — keeps union members intact (plain Omit collapses them). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Endpoint create body: any member of the Endpoint union without its id. */
export type EndpointBody = DistributiveOmit<Endpoint, 'id'>;

/** Error thrown for any non-2xx API response. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    });
  } catch {
    throw new ApiRequestError('Could not reach the server. Is it running?', 0);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body: unknown = await res.json();
      if (
        body &&
        typeof body === 'object' &&
        'error' in body &&
        typeof (body as { error: unknown }).error === 'string'
      ) {
        message = (body as { error: string }).error;
      }
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new ApiRequestError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/* ------------------------------ Monitor ------------------------------ */

export interface JobListResult {
  jobs: JobSummary[];
  total: number;
}

export const api = {
  /* Monitor */
  listJobs(opts: {
    status?: JobStatus;
    funnelId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<JobListResult> {
    return request<JobListResult>(`/api/monitor/jobs${qs(opts)}`);
  },
  getJob(id: string): Promise<Job> {
    return request<Job>(`/api/monitor/jobs/${encodeURIComponent(id)}`);
  },
  retryJob(id: string): Promise<{ jobId: string }> {
    return request<{ jobId: string }>(`/api/monitor/jobs/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    });
  },
  getStats(): Promise<MonitorStats> {
    return request<MonitorStats>('/api/monitor/stats');
  },

  /* Transforms (mappings) */
  listTransforms(kind?: TransformKind): Promise<TransformConfig[]> {
    return request<TransformConfig[]>(`/api/admin/transforms${qs({ kind })}`);
  },
  getTransform(id: string): Promise<TransformConfig> {
    return request<TransformConfig>(`/api/admin/transforms/${encodeURIComponent(id)}`);
  },
  createTransform(body: {
    name: string;
    kind: TransformKind;
    description?: string;
    jsonata?: string;
    graph?: TransformConfig['graph'];
    sampleInput?: unknown;
  }): Promise<TransformConfig> {
    return request<TransformConfig>('/api/admin/transforms', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  updateTransform(id: string, body: Partial<TransformConfig>): Promise<TransformConfig> {
    return request<TransformConfig>(`/api/admin/transforms/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },
  deleteTransform(id: string): Promise<void> {
    return request<void>(`/api/admin/transforms/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /* Funnels */
  listFunnels(): Promise<FunnelConfig[]> {
    return request<FunnelConfig[]>('/api/admin/funnels');
  },
  getFunnel(id: string): Promise<FunnelConfig> {
    return request<FunnelConfig>(`/api/admin/funnels/${encodeURIComponent(id)}`);
  },
  createFunnel(body: Omit<FunnelConfig, 'id'>): Promise<FunnelConfig> {
    return request<FunnelConfig>('/api/admin/funnels', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  updateFunnel(id: string, body: FunnelConfig): Promise<FunnelConfig> {
    return request<FunnelConfig>(`/api/admin/funnels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },
  deleteFunnel(id: string): Promise<void> {
    return request<void>(`/api/admin/funnels/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  testFunnel(id: string, body: TestFunnelRequest): Promise<TestFunnelResponse> {
    return request<TestFunnelResponse>(`/api/admin/funnels/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /* Endpoints */
  listEndpoints(direction?: EndpointDirection): Promise<Endpoint[]> {
    return request<Endpoint[]>(`/api/admin/endpoints${qs({ direction })}`);
  },
  getEndpoint(id: string): Promise<Endpoint> {
    return request<Endpoint>(`/api/admin/endpoints/${encodeURIComponent(id)}`);
  },
  createEndpoint(body: EndpointBody): Promise<Endpoint> {
    return request<Endpoint>('/api/admin/endpoints', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  updateEndpoint(id: string, body: Endpoint): Promise<Endpoint> {
    return request<Endpoint>(`/api/admin/endpoints/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },
  deleteEndpoint(id: string): Promise<void> {
    return request<void>(`/api/admin/endpoints/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  testEndpoint(id: string, content?: string): Promise<TestEndpointResponse> {
    return request<TestEndpointResponse>(`/api/admin/endpoints/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: JSON.stringify(content !== undefined ? { content } : {}),
    });
  },

  /* Utilities */
  evaluate(body: TestExpressionRequest): Promise<EvalResult> {
    return request<EvalResult>('/api/admin/evaluate', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  exportConfig(): Promise<ConfigBundle> {
    return request<ConfigBundle>('/api/admin/export');
  },
  importConfig(bundle: ConfigBundle): Promise<{
    imported: { endpoints: number; funnels: number; transforms: number };
  }> {
    return request('/api/admin/import', { method: 'POST', body: JSON.stringify(bundle) });
  },
};
