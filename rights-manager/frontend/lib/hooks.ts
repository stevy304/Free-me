"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Loads data, keeps the last good result on refresh, and optionally refreshes every `every` ms while `poll` is true. */
export function useData<T>(load: () => Promise<T>, deps: unknown[], opts: { every?: number; poll?: (data: T) => boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loader = useRef(load);
  loader.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loader.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const polling = !!(opts.every && data && opts.poll?.(data));
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => void refresh(), opts.every);
    return () => clearInterval(t);
  }, [polling, opts.every, refresh]);

  return { data, error, loading, refresh, setData };
}
