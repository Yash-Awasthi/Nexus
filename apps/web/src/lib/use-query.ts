// SPDX-License-Identifier: Apache-2.0
/**
 * Lightweight data-fetching hook — TanStack Query-compatible surface without
 * the npm dependency.
 *
 * useQuery<T>(fetcher, deps?)
 *   Fires fetcher() on mount and whenever deps change.
 *   Returns { data, loading, error, refetch }.
 *
 * useMutation<T, V>(mutator)
 *   Returns { mutate, loading, error, data }.
 *   Useful for POST/PATCH/DELETE with loading state and error handling.
 *
 * useInfiniteQuery<T>(fetcher, getCursor, deps?)
 *   Cursor-based infinite scroll.
 *   Returns { pages, loadMore, hasMore, loading, error }.
 */

import { useState, useEffect, useCallback, useRef } from "react";

// ── useQuery ──────────────────────────────────────────────────────────────────

export interface QueryResult<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useQuery<T>(fetcher: () => Promise<T>, deps: unknown[] = []): QueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const versionRef = useRef(0);

  const run = useCallback(async () => {
    const version = ++versionRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      if (version === versionRef.current) {
        setData(result);
      }
    } catch (err) {
      if (version === versionRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (version === versionRef.current) {
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { data, loading, error, refetch: run };
}

// ── useMutation ───────────────────────────────────────────────────────────────

export interface MutationResult<T, V> {
  mutate: (vars: V) => Promise<T | undefined>;
  loading: boolean;
  error: Error | null;
  data: T | undefined;
  reset: () => void;
}

export function useMutation<T, V = void>(mutator: (vars: V) => Promise<T>): MutationResult<T, V> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutate = useCallback(
    async (vars: V): Promise<T | undefined> => {
      setLoading(true);
      setError(null);
      try {
        const result = await mutator(vars);
        setData(result);
        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        return undefined;
      } finally {
        setLoading(false);
      }
    },
    [mutator],
  );

  const reset = useCallback(() => {
    setData(undefined);
    setError(null);
    setLoading(false);
  }, []);

  return { mutate, loading, error, data, reset };
}

// ── useInfiniteQuery ──────────────────────────────────────────────────────────

export interface InfiniteQueryResult<T> {
  pages: T[];
  loadMore: () => void;
  hasMore: boolean;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useInfiniteQuery<T>(
  fetcher: (cursor: string | null) => Promise<{ data: T; nextCursor: string | null }>,
  deps: unknown[] = [],
): InfiniteQueryResult<T> {
  const [pages, setPages] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchPage = useCallback(async (cur: string | null, reset = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetcher(cur);
      setPages((prev) => (reset ? [res.data] : [...prev, res.data]));
      setCursor(res.nextCursor);
      setHasMore(res.nextCursor !== null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    setPages([]);
    setCursor(null);
    setHasMore(true);
    fetchPage(null, true);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!loading && hasMore) fetchPage(cursor);
  }, [loading, hasMore, cursor, fetchPage]);

  const refetch = useCallback(() => {
    setPages([]);
    setCursor(null);
    setHasMore(true);
    fetchPage(null, true);
  }, [fetchPage]);

  return { pages, loadMore, hasMore, loading, error, refetch };
}
