import { useCallback, useEffect, useRef, useState } from "react";

export type PollState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
};

/**
 * Poll a fetcher on an interval, pausing while the tab is hidden so a
 * console left open overnight is not hammering SQLite.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs = 3000,
  deps: unknown[] = [],
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      try {
        const next = await fetcherRef.current();
        if (!alive) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void run();
    if (intervalMs <= 0) return () => {
      alive = false;
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  return { data, error, loading, refresh };
}
