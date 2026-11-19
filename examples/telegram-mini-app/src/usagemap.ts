// SPDX-License-Identifier: Apache-2.0
// UsageMap app events (wire-formats §a.9) for React Native, Expo and Telegram Mini Apps. Zero dependencies: only
// `fetch`. Counts are self-attested. Nothing persistent: the session id is random, held in memory and replaced at the
// latest after 30 minutes; no device id, install id, advertising id, user id or wallet address exists in the API.

export type Platform = "ios" | "android" | "web";
export type TmaPlatform = "android" | "ios" | "macos" | "desktop" | "web" | "other";

export interface UsageMapAppOptions {
  /** The site's public key (the `data-site` value of the web tag). */
  siteKey: string;
  /** React Native: `Platform.OS` ("ios" | "android"); a Mini App or web build: "web". */
  platform: Platform;
  /** The app's marketing version, e.g. "1.4.2" (a "-beta+77" suffix is removed by the edge). */
  appVersion: string;
  /** Default: https://e1.usagemap.dev/v1/app-events */
  endpoint?: string;
  /** Telegram Mini Apps only: `tmaPlatform(Telegram.WebApp.platform)`. */
  tmaPlatform?: TmaPlatform;
  /** Send automatically once this many events are queued (1–20, default 10). */
  batchSize?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export const SDK_VERSION = "mobile-rn/0.1.0";
const SESSION_MS = 30 * 60_000;
const MAX_QUEUE = 100;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,49}$/;
const KEY = /^[a-z][a-z0-9_]{0,31}$/;

interface QueuedEvent {
  ts: number;
  session: string;
  name: string;
  props?: Record<string, string>;
}

function randomId(): string {
  const b = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); // only for distinct counting
  return Array.from(
    b,
    (x) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[x & 63],
  ).join("");
}

/** Maps Telegram's `WebApp.platform` to the closed class of §a.9. Never read `initData` or the user object. */
export function tmaPlatform(raw: string | undefined): TmaPlatform {
  switch (raw) {
    case "android":
    case "android_x":
      return "android";
    case "ios":
    case "macos":
    case "web":
      return raw;
    case "tdesktop":
    case "unigram":
      return "desktop";
    case "weba":
    case "webk":
      return "web";
    default:
      return "other";
  }
}

export function createUsageMapApp(o: UsageMapAppOptions) {
  const send = o.fetch ?? globalThis.fetch.bind(globalThis);
  const now = o.now ?? Date.now;
  const endpoint = o.endpoint ?? "https://e1.usagemap.dev/v1/app-events";
  const batchSize = Math.min(Math.max(o.batchSize ?? 10, 1), 20);
  let queue: QueuedEvent[] = [];
  let session = "";
  let sessionStart = 0;
  let inFlight: Promise<void> | undefined;

  /** Queues one event. Returns false (and drops it) when the name or a property is not allowed. */
  function track(name: string, props?: Record<string, string>): boolean {
    if (!NAME.test(name)) return false;
    const p = props ?? {};
    const keys = Object.keys(p);
    if (keys.length > 8 || keys.some((k) => !KEY.test(k) || !KEY.test(String(p[k])))) return false;
    const t = now();
    if (!session || t - sessionStart >= SESSION_MS) [session, sessionStart] = [randomId(), t];
    queue.push({ ts: t, session, name, ...(keys.length ? { props: { ...p } } : {}) });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    if (queue.length >= batchSize) void flush();
    return true;
  }

  /** Sends the queue in batches of ≤ 20. Network errors, 429 and 5xx keep the events for the next flush. */
  function flush(): Promise<void> {
    inFlight ??= (async () => {
      try {
        while (queue.length > 0) {
          const events = queue.slice(0, 20);
          const body = {
            v: 1,
            k: o.siteKey,
            platform: o.platform,
            app_version: o.appVersion,
            sdk_version: SDK_VERSION,
            ...(o.tmaPlatform ? { tma_platform: o.tmaPlatform } : {}),
            events,
          };
          let status = 0;
          try {
            status = (
              await send(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              })
            ).status;
          } catch {}
          if (status === 0 || status === 429 || status >= 500) return; // retry later
          const sent = new Set(events); // 2xx, or a 4xx the edge will never accept: drop what was sent
          queue = queue.filter((e) => !sent.has(e));
        }
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  return { track, flush, pending: () => queue.length };
}
