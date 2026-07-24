import { useRef, useState } from 'react';
import type { ConfigBundle } from '@transformata/shared';
import { api } from '../api';
import { useToast } from '../components/Toasts';

export default function SettingsPage() {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importedCounts, setImportedCounts] = useState<{
    endpoints: number;
    funnels: number;
    transforms: number;
  } | null>(null);

  const doExport = async () => {
    setExporting(true);
    try {
      const bundle = await api.exportConfig();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `transformata-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Configuration exported.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  const doImport = async (file: File) => {
    setImporting(true);
    setImportedCounts(null);
    try {
      const text = await file.text();
      let bundle: ConfigBundle;
      try {
        bundle = JSON.parse(text) as ConfigBundle;
      } catch {
        throw new Error('That file is not valid JSON. Please pick a config export file.');
      }
      const res = await api.importConfig(bundle);
      setImportedCounts(res.imported);
      toast('Configuration imported.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Import failed', 'error');
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <main className="page">
      <h1>Settings</h1>
      <p className="page-sub">Back up and restore everything you configured — endpoints, funnels and mappings.</p>

      <div className="card card-pad section">
        <h2>Export configuration</h2>
        <p className="help" style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          Downloads a single JSON file with all endpoints, funnels and mappings. Keep it somewhere
          safe or commit it to your repository.
        </p>
        <button type="button" className="btn primary" onClick={doExport} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Download config file'}
        </button>
      </div>

      <div className="card card-pad section">
        <h2>Import configuration</h2>
        <p className="help" style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          Pick a previously exported config file. Existing items with the same id are updated;
          nothing is ever deleted.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          disabled={importing}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doImport(f);
          }}
        />
        {importedCounts && (
          <div className="banner success" style={{ marginTop: 14, marginBottom: 0 }}>
            Imported {importedCounts.endpoints} endpoint(s), {importedCounts.funnels} funnel(s) and{' '}
            {importedCounts.transforms} mapping(s).
          </div>
        )}
      </div>

      <div className="banner warn">
        <strong>Heads up if you run on Render's free tier:</strong> the server's disk is wiped on
        every restart or deploy. Configuration changes you make in this admin panel live on that
        disk — export your config after making changes and commit the files to your repository so
        they are restored on the next boot.
      </div>
    </main>
  );
}
