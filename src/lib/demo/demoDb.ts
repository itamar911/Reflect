// Chainable stand-in for supabase's PostgREST query builder, used in demo mode.
//
// Reads resolve fixture rows (filters are no-ops — fixtures are single-user);
// `.order()` is honored because page logic depends on sort direction.
// Writes never touch the network: they resolve a DEMO error and fire `onWrite`
// so the UI can raise the signup upsell.

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete']);

/** Raised whenever a demo visitor attempts a mutating action. */
export const DEMO_UPSELL_EVENT = 'demo-upsell';

export function triggerDemoUpsell() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DEMO_UPSELL_EVENT));
}

interface QueryResult {
  data: unknown;
  error: { message: string; code: string } | null;
  count: number | null;
}

export const DEMO_WRITE_ERROR = {
  message: 'Demo mode — writes are disabled',
  code: 'DEMO',
};

export function createDemoQuery(
  rows: Record<string, unknown>[] | undefined,
  onWrite?: () => void,
): PromiseLike<QueryResult> {
  let isWrite = false;
  let single = false;
  let order: { col: string; asc: boolean } | null = null;
  let limit: number | null = null;

  function exec(): QueryResult {
    if (isWrite) {
      onWrite?.();
      return { data: null, error: DEMO_WRITE_ERROR, count: null };
    }
    let data = [...(rows ?? [])];
    if (order) {
      const { col, asc } = order;
      data.sort((a, b) => {
        const av = a[col] as string | number | null;
        const bv = b[col] as string | number | null;
        if (av == null || bv == null) return av == null ? 1 : -1;
        return (av < bv ? -1 : av > bv ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    if (limit != null) data = data.slice(0, limit);
    if (single) {
      return data.length > 0
        ? { data: data[0], error: null, count: null }
        : { data: null, error: { message: 'no rows', code: 'PGRST116' }, count: null };
    }
    return { data, error: null, count: data.length };
  }

  const proxy: PromiseLike<QueryResult> = new Proxy(function noop() {} as never, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') {
        return (
          resolve: (r: QueryResult) => unknown,
          reject?: (e: unknown) => unknown,
        ) => Promise.resolve(exec()).then(resolve, reject);
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => { single = true; return proxy; };
      }
      if (prop === 'order') {
        return (col: string, opts?: { ascending?: boolean }) => {
          order = { col, asc: opts?.ascending ?? true };
          return proxy;
        };
      }
      if (prop === 'limit') {
        return (n: number) => { limit = n; return proxy; };
      }
      // select/eq/neq/not/in/gte/lte/filter/… — and the write methods
      return (..._args: unknown[]) => {
        if (WRITE_METHODS.has(prop)) isWrite = true;
        return proxy;
      };
    },
  }) as never;

  return proxy;
}

/** No-op realtime channel — `.on()`/`.subscribe()` chain but never connect. */
export function createDemoChannel() {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
    unsubscribe: async () => 'ok' as const,
  };
  return channel;
}
