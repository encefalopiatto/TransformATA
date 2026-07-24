/**
 * Lightweight unsaved-changes navigation guard.
 *
 * The app uses a plain BrowserRouter (not a data router), so React Router's
 * useBlocker is unavailable. Instead a component registers a guard while it has
 * unsaved changes; the top-nav links consult it before navigating, and a
 * `beforeunload` handler covers tab close / refresh.
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

/** Returns true if navigation is allowed to proceed. */
export type NavGuard = () => boolean;

interface NavGuardApi {
  register: (guard: NavGuard | null) => void;
  /** Consulted by nav links; true = allow navigation. */
  check: () => boolean;
}

const NavGuardContext = createContext<NavGuardApi | null>(null);

export function NavGuardProvider({ children }: { children: ReactNode }) {
  const guardRef = useRef<NavGuard | null>(null);
  const api = useMemo<NavGuardApi>(
    () => ({
      register: (guard) => {
        guardRef.current = guard;
      },
      check: () => (guardRef.current ? guardRef.current() : true),
    }),
    [],
  );
  return <NavGuardContext.Provider value={api}>{children}</NavGuardContext.Provider>;
}

export function useNavGuardApi(): NavGuardApi {
  const api = useContext(NavGuardContext);
  if (!api) throw new Error('useNavGuardApi must be used within a NavGuardProvider');
  return api;
}

/**
 * Registers an unsaved-changes guard while `dirty` is true, and installs a
 * matching `beforeunload` handler for tab close / refresh. `message` is shown
 * in the in-app confirm() when leaving via a guarded link.
 */
export function useUnsavedGuard(dirty: boolean, message: string): void {
  const api = useContext(NavGuardContext);

  useEffect(() => {
    if (!api) return;
    if (!dirty) {
      api.register(null);
      return;
    }
    api.register(() => window.confirm(message));
    return () => api.register(null);
  }, [api, dirty, message]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
