import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { JobStatus, JobSummary, MonitorStats } from '@transformata/shared';
import { api } from '../api';
import { EmptyState, ErrorBanner, Loading, StatusChip, formatDateTime } from '../components/ui';

type StatusFilter = JobStatus | 'all';

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'queued', label: 'Queued' },
  { key: 'processing', label: 'Processing' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
];

const STAT_CARDS: { key: keyof MonitorStats; label: string; color: string }[] = [
  { key: 'queued', label: 'Waiting', color: 'var(--text-faint)' },
  { key: 'processing', label: 'In progress', color: 'var(--blue)' },
  { key: 'completed', label: 'Completed', color: 'var(--green)' },
  { key: 'failed', label: 'Failed', color: 'var(--red)' },
];

export default function MonitorPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<MonitorStats | null>(null);
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  const filterRef = useRef(filter);
  filterRef.current = filter;

  const refresh = useCallback(async () => {
    const status = filterRef.current;
    try {
      const [statsRes, jobsRes] = await Promise.all([
        api.getStats(),
        api.listJobs({ status: status === 'all' ? undefined : status, limit: 100 }),
      ]);
      setStats(statsRes);
      setJobs(jobsRes.jobs);
      setTotal(jobsRes.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    }
  }, []);

  // Initial load + reload when the filter changes.
  useEffect(() => {
    setJobs(null);
    void refresh();
  }, [filter, refresh]);

  // Live updates: SSE stream with ~500ms debounced list refresh; fall back
  // to 5s polling if the stream errors.
  useEffect(() => {
    let debounceTimer: number | undefined;
    let pollTimer: number | undefined;
    let closed = false;

    const source = new EventSource('/api/monitor/stream');

    const scheduleRefresh = () => {
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        void refresh();
      }, 500);
    };

    source.addEventListener('job', scheduleRefresh);
    source.addEventListener('stats', (ev: MessageEvent<string>) => {
      try {
        setStats(JSON.parse(ev.data) as MonitorStats);
      } catch {
        /* malformed stats event — the next refresh will correct it */
      }
    });
    source.onopen = () => {
      if (!closed) setLive(true);
    };
    source.onerror = () => {
      if (closed) return;
      setLive(false);
      // EventSource retries on its own; poll while it is down.
      if (pollTimer === undefined) {
        pollTimer = window.setInterval(() => {
          if (source.readyState === EventSource.OPEN) {
            window.clearInterval(pollTimer);
            pollTimer = undefined;
            setLive(true);
          } else {
            void refresh();
          }
        }, 5000);
      }
    };

    return () => {
      closed = true;
      source.close();
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
    };
  }, [refresh]);

  return (
    <main className="page">
      <div className="page-head">
        <h1>Monitor</h1>
        <span className={`live-dot ${live ? '' : 'stale'}`}>
          <span className="pulse" />
          {live ? 'Live updates on' : 'Reconnecting — refreshing every 5s'}
        </span>
      </div>
      <p className="page-sub">
        Every file that enters TransformATA shows up here in real time. Click a row to see exactly
        what happened at each step.
      </p>

      {error && <ErrorBanner message={error} />}

      <div className="stat-grid">
        {STAT_CARDS.map((c) => (
          <div key={c.key} className="card stat-card">
            <span className="stat-label">
              <span className="stat-dot" style={{ background: c.color }} />
              {c.label}
            </span>
            <span className="stat-value">{stats ? stats[c.key] : '–'}</span>
          </div>
        ))}
      </div>

      <div className="tabs">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={filter === f.key ? 'active' : undefined}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="card">
        {jobs === null ? (
          <Loading label="Loading jobs…" />
        ) : jobs.length === 0 ? (
          <EmptyState icon="📥" title="No files yet">
            {filter === 'all'
              ? 'Send a file to an inbound endpoint and it will appear here instantly.'
              : `No ${filter} jobs right now.`}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>File</th>
                  <th>From</th>
                  <th>Funnel</th>
                  <th>Status</th>
                  <th>Current step</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.id}
                    className="clickable"
                    onClick={() => navigate(`/jobs/${job.id}`)}
                  >
                    <td className="cell-nowrap cell-muted">{formatDateTime(job.createdAt)}</td>
                    <td className="cell-mono">{job.source.fileName ?? '—'}</td>
                    <td>{job.source.endpointName ?? job.source.endpointId}</td>
                    <td>{job.funnelName ?? (job.funnelId ?? <span className="cell-muted">—</span>)}</td>
                    <td>
                      <StatusChip status={job.status} />
                    </td>
                    <td className="cell-muted" style={{ textTransform: 'capitalize' }}>
                      {job.currentStage ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {jobs !== null && total > jobs.length && (
        <p className="page-sub" style={{ marginTop: 10 }}>
          Showing the {jobs.length} most recent of {total} jobs.
        </p>
      )}
    </main>
  );
}
