import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Job } from '@transformata/shared';
import { api } from '../api';
import StageTimeline from '../components/StageTimeline';
import { ErrorBanner, Loading, StatusChip, formatDateTime } from '../components/ui';
import { useToast } from '../components/Toasts';

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setJob(await api.getJob(id));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the job');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh while the job is still moving.
  useEffect(() => {
    if (!job || job.status === 'completed' || job.status === 'failed') return;
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [job, load]);

  const retry = async () => {
    if (!id) return;
    setRetrying(true);
    try {
      const { jobId } = await api.retryJob(id);
      toast('Retry started — following the new job.', 'success');
      navigate(`/jobs/${jobId}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Retry failed', 'error');
    } finally {
      setRetrying(false);
    }
  };

  if (error) {
    return (
      <main className="page">
        <ErrorBanner message={error} />
        <Link to="/">← Back to monitor</Link>
      </main>
    );
  }
  if (!job) {
    return (
      <main className="page">
        <Loading label="Loading job…" />
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <Link to="/" style={{ fontSize: 13 }}>
            ← Back to monitor
          </Link>
          <h1 style={{ marginTop: 6 }}>
            Job <code>{job.id}</code>
          </h1>
        </div>
        <div className="btn-row">
          <StatusChip status={job.status} />
          {job.status === 'failed' && (
            <button type="button" className="btn primary" onClick={retry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Retry this file'}
            </button>
          )}
        </div>
      </div>

      <div className="card card-pad section" style={{ marginTop: 18 }}>
        <dl className="kv">
          <dt>Received</dt>
          <dd>{formatDateTime(job.createdAt)}</dd>
          <dt>Last update</dt>
          <dd>{formatDateTime(job.updatedAt)}</dd>
          <dt>File name</dt>
          <dd>{job.source.fileName ?? '—'}</dd>
          <dt>Came in via</dt>
          <dd>
            {job.source.endpointName ?? job.source.endpointId} ({job.source.via})
          </dd>
          {job.source.retryOf && (
            <>
              <dt>Retry of</dt>
              <dd>
                <Link to={`/jobs/${job.source.retryOf}`}>{job.source.retryOf}</Link>
              </dd>
            </>
          )}
          <dt>Funnel</dt>
          <dd>{job.funnelName ?? job.funnelId ?? '— (not routed yet)'}</dd>
          {job.output && (
            <>
              <dt>Delivered to</dt>
              <dd>
                {job.output.endpointName ?? job.output.endpointId}
                {job.output.deliveredTo ? ` — ${job.output.deliveredTo}` : ''}
              </dd>
            </>
          )}
          {job.attempts > 1 && (
            <>
              <dt>Attempts</dt>
              <dd>{job.attempts}</dd>
            </>
          )}
        </dl>
        {job.error && (
          <div className="banner error" style={{ marginTop: 14, marginBottom: 0 }}>
            {job.error}
          </div>
        )}
      </div>

      <div className="card card-pad">
        <h2>What happened, step by step</h2>
        <StageTimeline stages={job.stages} />
      </div>
    </main>
  );
}
