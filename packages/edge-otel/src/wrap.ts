// SPDX-License-Identifier: Apache-2.0
// Wrappers for fetch-style handlers: `(request, ...rest) => Response`.
//
//   Cloudflare Workers   export default withUsageMap({ fetch(req, env, ctx) {…} }, (env) => ({…}))
//   Vercel Edge          export default withUsageMap((req, ctx) => …, {…})   (ctx.waitUntil is used)
//   Next.js route        export const GET = usagemap.wrap(handler, { route: "/api/items/[id]" })
//   Deno                 Deno.serve(withUsageMap(handler, {…, flushTimer: true}))
//   Bun                  Bun.serve({ fetch: withUsageMap(handler, {…, flushTimer: true}) })
//
// The export never delays the response: it is started after the handler has
// returned and handed to the runtime's waitUntil when there is one (Workers
// `ctx`, Vercel's request context, or `options.waitUntil`); otherwise it runs
// in the background. Nothing here can throw into the application: invalid or
// missing options turn the wrapper into a pass-through.

import {
  createRecorder,
  invalidReason,
  type Recorder,
  type RecorderOptions,
  type RecorderStats,
} from "./recorder.ts";
import { compileRoute } from "./routes.ts";

// biome-ignore lint/suspicious/noExplicitAny: runtime-specific `this` and extra arguments (env, ctx, server, info …)
type Loose = any;
export type FetchHandler = (
  this: Loose,
  request: Request,
  ...rest: Loose[]
) => Response | Promise<Response>;
export type WaitUntil = (promise: Promise<unknown>) => void;

export interface EdgeOptions extends RecorderOptions {
  /** Keep the runtime alive for the export (Vercel: `waitUntil` from `@vercel/functions`). */
  waitUntil?: WaitUntil | undefined;
  /** Long-lived servers (Deno, Bun, Node): also export on a timer, so the last window is not held until the next request. */
  flushTimer?: boolean | undefined;
  /** false turns analytics off (the handler runs unchanged). */
  enabled?: boolean | undefined;
  /** Log once, with console.warn, why analytics is off (default true). Never logs request data. */
  warn?: boolean | undefined;
}

export interface WrapOptions {
  /** The route template of this handler (a Next.js route file handles one route), e.g. "/api/items/[id]". */
  route?: string | undefined;
}

export interface UsageMap {
  readonly enabled: boolean;
  readonly disabledReason: string | undefined;
  readonly stats: RecorderStats;
  /** Wrap one fetch-style handler. Disabled: returns the handler itself. */
  wrap<H extends FetchHandler>(handler: H, options?: WrapOptions): H;
  /** Export what has been recorded so far (never rejects). */
  flush(): Promise<void>;
  /** Stop the timer and export what is left (SIGTERM handlers, tests). */
  shutdown(): Promise<void>;
}

const now = (o: EdgeOptions) => o.now ?? Date.now;

function findWaitUntil(o: EdgeOptions, rest: unknown[]): WaitUntil | undefined {
  if (o.waitUntil) return o.waitUntil;
  for (const a of rest) {
    const w = (a as { waitUntil?: unknown } | null | undefined)?.waitUntil;
    if (typeof w === "function") return (w as WaitUntil).bind(a);
  }
  return undefined;
}

const emptyStats = (): RecorderStats => ({
  recorded: 0,
  exportedBatches: 0,
  failedExports: 0,
  droppedBatches: 0,
});

function disabled(reason: string, warn: boolean): UsageMap {
  if (warn) console.warn(`usagemap edge-otel: analytics off (${reason})`);
  return {
    enabled: false,
    disabledReason: reason,
    stats: emptyStats(),
    wrap: (h) => h,
    flush: async () => {},
    shutdown: async () => {},
  };
}

/** Create one instance (one batch) and wrap any number of handlers with it. */
export function createUsageMap(options: EdgeOptions): UsageMap {
  const warn = options.warn ?? true;
  if (options.enabled === false) return disabled("enabled: false", false);
  const bad = invalidReason(options);
  if (bad) return disabled(bad, warn);
  let rec: Recorder;
  try {
    rec = createRecorder(options);
  } catch (e) {
    return disabled(e instanceof Error ? e.message : "invalid options", warn);
  }
  const clock = now(options);
  let timer: ReturnType<typeof setInterval> | undefined;
  if (options.flushTimer) {
    timer = setInterval(() => void rec.flush(), Math.max(1_000, options.flushIntervalMs ?? 10_000));
    (timer as { unref?: () => void }).unref?.();
  }

  function after(
    method: string,
    route: string | undefined,
    status: number,
    t0: number,
    rest: unknown[],
  ) {
    try {
      rec.record(method, route, status, (clock() - t0) / 1000);
      if (!rec.due()) return;
      const p = rec.flush();
      const waitUntil = findWaitUntil(options, rest);
      if (waitUntil) {
        try {
          waitUntil(p);
        } catch {
          // waitUntil outside a request (or after the response) must not break the app.
        }
      }
    } catch {
      // never break the application
    }
  }

  return {
    enabled: true,
    disabledReason: undefined,
    stats: rec.stats,
    wrap<H extends FetchHandler>(handler: H, w: WrapOptions = {}): H {
      const fixed = w.route === undefined ? undefined : compileRoute(w.route).route;
      const wrapped = async function (this: unknown, request: Request, ...rest: unknown[]) {
        const t0 = clock();
        let status = 500;
        try {
          const res = await handler.call(this, request, ...rest);
          status = typeof res?.status === "number" ? res.status : 200;
          return res;
        } finally {
          let route = fixed;
          let method = "GET";
          try {
            method = request.method;
            route ??= rec.routeFor(new URL(request.url).pathname);
          } catch {
            route = undefined;
          }
          after(method, route, status, t0, rest);
        }
      };
      return wrapped as unknown as H;
    },
    flush: () => rec.flush(),
    async shutdown() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await rec.flush();
    },
  };
}

type OptionsInput = EdgeOptions | ((env: unknown) => EdgeOptions | undefined);

/**
 * Wrap a handler function or a module object with a `fetch` method (Workers
 * module syntax, Bun.serve options). `options` may be a function of the
 * Workers `env` (module form), so the token can come from a Worker secret;
 * it is resolved once, on the first request.
 */
export function withUsageMap<H extends FetchHandler | { fetch: FetchHandler }>(
  handler: H,
  options: OptionsInput,
): H {
  const isModule = typeof handler !== "function";
  const inner: FetchHandler = isModule
    ? (handler as { fetch: FetchHandler }).fetch
    : (handler as FetchHandler);
  if (typeof inner !== "function")
    throw new TypeError("withUsageMap: handler must be a function or have a fetch method");
  let instance: UsageMap | undefined;
  let wrapped: FetchHandler | undefined;
  const resolve = (env: unknown): FetchHandler => {
    if (!wrapped) {
      let o: EdgeOptions | undefined;
      try {
        o = typeof options === "function" ? options(env) : options;
      } catch {
        o = undefined;
      }
      instance = o ? createUsageMap(o) : disabled("no options", true);
      wrapped = instance.wrap(inner);
    }
    return wrapped;
  };
  const fetchFn = function (this: unknown, request: Request, ...rest: unknown[]) {
    return resolve(isModule ? rest[0] : undefined).call(this, request, ...rest);
  };
  if (!isModule) return fetchFn as unknown as H;
  return { ...(handler as object), fetch: fetchFn } as H;
}
