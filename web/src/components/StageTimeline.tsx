import { useState } from 'react';
import type { StageRecord } from '@transformata/shared';
import { formatDuration } from './ui';

function prettySnapshot(snapshot: string): string {
  try {
    return JSON.stringify(JSON.parse(snapshot), null, 2);
  } catch {
    return snapshot;
  }
}

const ICONS: Record<StageRecord['status'], string> = {
  ok: '✓',
  error: '✕',
  skipped: '–',
};

function TimelineRow({ record }: { record: Omit<StageRecord, 'snapshot'> & { snapshot?: string } }) {
  const [open, setOpen] = useState(false);
  const duration =
    new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime();

  return (
    <div className="timeline-row">
      <span className={`tl-icon ${record.status}`} aria-label={record.status}>
        {ICONS[record.status]}
      </span>
      <div className="tl-body">
        <div className="tl-top">
          <span className="tl-stage">{record.stage}</span>
          <span className="tl-duration">{formatDuration(duration)}</span>
          {record.status === 'skipped' && <span className="chip off">skipped</span>}
        </div>
        {record.detail && <div className="tl-detail">{record.detail}</div>}
        {record.error && <div className="tl-error">{record.error}</div>}
        {record.snapshot !== undefined && record.snapshot !== '' && (
          <div className="tl-snapshot-toggle">
            <button type="button" className="btn ghost sm" onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide data' : 'Show data after this step'}
            </button>
            {open && (
              <div className="tl-snapshot">
                <pre>{prettySnapshot(record.snapshot)}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Renders one row per pipeline stage record. Works for full Job stages
 * (with snapshots) and for funnel test results.
 */
export default function StageTimeline({ stages }: { stages: StageRecord[] }) {
  if (stages.length === 0) {
    return <div className="cell-muted">No steps recorded yet.</div>;
  }
  return (
    <div className="timeline">
      {stages.map((s, i) => (
        <TimelineRow key={`${s.stage}-${i}`} record={s} />
      ))}
    </div>
  );
}
