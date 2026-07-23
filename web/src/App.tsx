import { NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { ToastProvider } from './components/Toasts';
import EditorScreen from './editor/EditorScreen';
import MonitorPage from './pages/MonitorPage';
import JobDetailPage from './pages/JobDetailPage';
import FunnelsPage from './pages/FunnelsPage';
import FunnelEditPage from './pages/FunnelEditPage';
import TransformsPage from './pages/TransformsPage';
import EndpointsPage from './pages/EndpointsPage';
import EndpointEditPage from './pages/EndpointEditPage';
import SettingsPage from './pages/SettingsPage';

function TransformEditorRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/admin/transforms" replace />;
  // Full-bleed: fills the viewport below the top bar, no page padding.
  return (
    <div className="page-full">
      <EditorScreen transformId={id} />
    </div>
  );
}

const NAV = [
  { to: '/', label: 'Monitor', end: true },
  { to: '/admin/funnels', label: 'Funnels' },
  { to: '/admin/transforms', label: 'Mappings' },
  { to: '/admin/endpoints', label: 'Endpoints' },
  { to: '/admin/settings', label: 'Settings' },
];

export default function App() {
  return (
    <ToastProvider>
      <header className="topbar">
        <NavLink to="/" className="brand">
          <span className="brand-mark" aria-hidden>
            T
          </span>
          TransformATA
        </NavLink>
        <nav className="topnav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? 'active' : undefined)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<MonitorPage />} />
        <Route path="/jobs/:id" element={<JobDetailPage />} />
        <Route path="/admin/funnels" element={<FunnelsPage />} />
        <Route path="/admin/funnels/new" element={<FunnelEditPage />} />
        <Route path="/admin/funnels/:id" element={<FunnelEditPage />} />
        <Route path="/admin/transforms" element={<TransformsPage />} />
        <Route path="/admin/transforms/:id/edit" element={<TransformEditorRoute />} />
        <Route path="/admin/endpoints" element={<EndpointsPage />} />
        <Route path="/admin/endpoints/new" element={<EndpointEditPage />} />
        <Route path="/admin/endpoints/:id" element={<EndpointEditPage />} />
        <Route path="/admin/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  );
}
