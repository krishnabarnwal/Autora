import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Poll a fetcher on an interval and expose {data, error, loading, stale}.
 *
 * Three behaviours the dashboard depends on:
 *
 *  - The first load is the only one that shows a spinner. Later refreshes keep
 *    the previous data on screen, so a live dashboard does not flash empty every
 *    few seconds.
 *  - A failed refresh does not discard the last good data; it sets `stale`. A
 *    backend restart therefore degrades the view instead of blanking it.
 *  - Polling pauses while the tab is hidden and refetches immediately on return,
 *    so a backgrounded dashboard is not still hammering the API an hour later.
 *
 * @param {() => Promise<any>} fetcher
 * @param {{intervalMs?: number, enabled?: boolean, deps?: any[]}} [options]
 */
export function usePolling(fetcher, { intervalMs = 8000, enabled = true, deps = [] } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [stale, setStale] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Kept in a ref so changing the fetcher identity every render (an inline
  // arrow, which every caller uses) does not restart the interval.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const hasDataRef = useRef(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const next = await fetcherRef.current();
      if (!mountedRef.current) return;
      setData(next);
      hasDataRef.current = true;
      setError(null);
      setStale(false);
      setLastUpdated(new Date());
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err);
      // Keep whatever is on screen; mark it as no longer confirmed live.
      if (hasDataRef.current) setStale(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    load();
    let timer = window.setInterval(load, intervalMs);

    const onVisibility = () => {
      window.clearInterval(timer);
      if (document.visibilityState === 'visible') {
        load();
        timer = window.setInterval(load, intervalMs);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps is the caller's explicit reset key.
  }, [load, intervalMs, enabled, ...deps]);

  return { data, error, loading, stale, lastUpdated, refresh: load };
}
