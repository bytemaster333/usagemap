// SPDX-License-Identifier: Apache-2.0
// Closed sets and pure classification rules. Every attribute value this package emits is one of the constants below
// (or a home domain that passed `homeDomainOf`); nothing taken from a URL, body, header or error message is copied.

/** SEPs whose wallet-side calls are classified. `stellar.sep` carries the number as a string. */
export const SEPS = ["1", "6", "10", "12", "24", "31", "38"] as const;
export type Sep = (typeof SEPS)[number];

/** `stellar.anchor.step`: one value per SEP endpoint a wallet calls (`other` = registered server, unknown path). */
export const STEPS = [
  "toml",
  "challenge",
  "token",
  "info",
  "fee",
  "deposit",
  "withdraw",
  "deposit_exchange",
  "withdraw_exchange",
  "transactions",
  "transaction",
  "customer_get",
  "customer_put",
  "customer_delete",
  "customer_callback",
  "customer_verification",
  "customer_files",
  "deposit_interactive",
  "withdraw_interactive",
  "transaction_create",
  "transaction_update",
  "transaction_callback",
  "prices",
  "price",
  "quote_create",
  "quote",
  "other",
] as const;
export type Step = (typeof STEPS)[number];

/** `stellar.anchor.outcome`: the class of a request's result. */
export const OUTCOMES = [
  "ok",
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limited",
  "client_error",
  "server_error",
  "timeout",
  "network",
  "canceled",
  "invalid_response",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Transfer kinds as they appear in event names (`exchange` variants fold into their base kind). */
export const KINDS = ["deposit", "withdraw", "receive"] as const;
export type Kind = (typeof KINDS)[number];

/** Lifecycle classes of a transfer, reached by the anchor's `status` (SEP-6/24/31 status lists). */
export const LIFECYCLE = [
  "started",
  "pending_user",
  "pending_anchor",
  "completed",
  "refunded",
  "expired",
  "failed",
] as const;
export type Lifecycle = (typeof LIFECYCLE)[number];

/** `stellar.anchor.event`: funnel events. Read `sep24` + `deposit_interactive_started` as "sep24.interactive_started". */
export const EVENTS = [
  "toml_resolved",
  "toml_failed",
  "challenge_received",
  "authenticated",
  "auth_failed",
  "customer_needs_info",
  "customer_processing",
  "customer_accepted",
  "customer_rejected",
  "customer_submitted",
  "customer_deleted",
  "kyc_required",
  "deposit_requested",
  "withdraw_requested",
  "deposit_interactive_started",
  "withdraw_interactive_started",
  "deposit_request_failed",
  "withdraw_request_failed",
  "receive_requested",
  "receive_request_failed",
  "price_quoted",
  "quote_created",
  "quote_failed",
  ...KINDS.flatMap((k) => LIFECYCLE.map((l) => `${k}_${l}` as const)),
] as const;
export type AnchorEvent = (typeof EVENTS)[number];

export const NETWORKS = ["mainnet", "testnet", "futurenet", "local", "unknown"] as const;
export type Network = (typeof NETWORKS)[number];

/** Value used for a home domain that is not a public DNS name or is over the per-process cap. */
export const OTHER = "_OTHER";

const PASSPHRASES: Record<string, Network> = {
  "Public Global Stellar Network ; September 2015": "mainnet",
  "Test SDF Network ; September 2015": "testnet",
  "Test SDF Future Network ; October 2022": "futurenet",
  "Standalone Network ; February 2017": "local",
};

/** Network name from a name or a passphrase; anything else is `unknown`. */
export function networkOf(v: unknown): Network {
  if (typeof v !== "string") return "unknown";
  if ((NETWORKS as readonly string[]).includes(v)) return v as Network;
  if (v === "public" || v === "pubnet") return "mainnet";
  return PASSPHRASES[v] ?? "unknown";
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NON_PUBLIC_TLDS = new Set([
  "localhost",
  "local",
  "internal",
  "test",
  "example",
  "invalid",
  "lan",
  "home",
  "corp",
  "onion",
  "arpa",
]);
/** A label that looks like a key, hash or StrKey rather than a name (never a real anchor's domain). */
const SECRETISH = /^(?:[a-z2-7]{52,}|[0-9a-f]{32,})$/;

/**
 * The public home domain an anchor is known by, lower-cased, without port or trailing dot; `_OTHER` for anything that
 * is not a public DNS name (IP literals, single labels, `localhost`, reserved TLDs, key-like labels, over 253 bytes).
 * Accepts a bare domain, `host:port` or a URL (only its host is read).
 */
export function homeDomainOf(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 2048) return OTHER;
  let host = input.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return OTHER;
    }
  }
  if (host.startsWith("[")) return OTHER; // IPv6 literal
  host = host.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) return OTHER;
  const labels = host.split(".");
  if (labels.length < 2) return OTHER;
  for (const l of labels) if (!LABEL.test(l) || SECRETISH.test(l)) return OTHER;
  const tld = labels[labels.length - 1] as string;
  if (/^\d+$/.test(tld) || NON_PUBLIC_TLDS.has(tld)) return OTHER;
  return host;
}

/** Outcome class of an HTTP status. */
export function outcomeOfStatus(status: number): Outcome {
  if (status >= 200 && status < 400) return "ok";
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500 && status < 600) return "server_error";
  return "invalid_response";
}

/** Outcome class of a thrown error (axios errors, fetch errors, stellar-sdk TOML resolver errors). */
export function outcomeOfError(e: unknown): Outcome {
  if (!e || typeof e !== "object") return "invalid_response";
  const err = e as {
    response?: { status?: unknown };
    code?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: { code?: unknown };
  };
  const status = err.response?.status;
  if (typeof status === "number") return outcomeOfStatus(status);
  const code =
    typeof err.code === "string"
      ? err.code
      : typeof err.cause?.code === "string"
        ? err.cause.code
        : "";
  const name = typeof err.name === "string" ? err.name : "";
  const msg = typeof err.message === "string" ? err.message.toLowerCase() : "";
  if (code === "ERR_CANCELED" || name === "CanceledError" || name === "AbortError")
    return "canceled";
  if (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    name === "TimeoutError" ||
    msg.includes("timeout")
  )
    return "timeout";
  if (
    code === "ERR_NETWORK" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "EPIPE" ||
    // fetch (undici, browsers): a TypeError without a status is a transport failure.
    (name === "TypeError" &&
      (msg === "fetch failed" || msg === "failed to fetch" || msg.includes("networkerror")))
  )
    return "network";
  return "invalid_response";
}

type Rule = readonly [method: string, path: RegExp, step: Step];
const SEG = "[^/]+";
const r = (method: string, path: string, step: Step): Rule => [
  method,
  new RegExp(`^${path}$`),
  step,
];

/** Endpoint rules per SEP, matched on the path below the server's base URL (no trailing slash, no query). */
export const RULES: Readonly<Record<Exclude<Sep, "1">, readonly Rule[]>> = {
  "10": [r("GET", "", "challenge"), r("POST", "", "token")],
  "6": [
    r("*", "/info", "info"),
    r("*", "/fee", "fee"),
    r("*", "/deposit", "deposit"),
    r("*", "/withdraw", "withdraw"),
    r("*", "/deposit-exchange", "deposit_exchange"),
    r("*", "/withdraw-exchange", "withdraw_exchange"),
    r("GET", "/transactions", "transactions"),
    r("GET", "/transaction", "transaction"),
  ],
  "12": [
    r("GET", "/customer", "customer_get"),
    r("PUT", "/customer", "customer_put"),
    r("PUT", "/customer/callback", "customer_callback"),
    r("*", "/customer/verification", "customer_verification"),
    r("*", "/customer/files(?:/[^/]+)?", "customer_files"),
    r("DELETE", `/customer/${SEG}`, "customer_delete"),
  ],
  "24": [
    r("GET", "/info", "info"),
    r("GET", "/fee", "fee"),
    r("POST", "/transactions/deposit/interactive", "deposit_interactive"),
    r("POST", "/transactions/withdraw/interactive", "withdraw_interactive"),
    r("GET", "/transactions", "transactions"),
    r("GET", "/transaction", "transaction"),
  ],
  "31": [
    r("GET", "/info", "info"),
    r("POST", "/transactions", "transaction_create"),
    r("GET", `/transactions/${SEG}`, "transaction"),
    r("PATCH", `/transactions/${SEG}`, "transaction_update"),
    r("PUT", `/transactions/${SEG}/callback`, "transaction_callback"),
  ],
  "38": [
    r("GET", "/info", "info"),
    r("GET", "/prices", "prices"),
    r("GET", "/price", "price"),
    r("POST", "/quote", "quote_create"),
    r("GET", `/quote/${SEG}`, "quote"),
  ],
};

/** Step of a request below a server of the given SEP; `other` when no rule matches. */
export function stepOf(sep: Exclude<Sep, "1">, method: string, rest: string): Step {
  const m = method.toUpperCase();
  for (const [rm, re, step] of RULES[sep])
    if ((rm === "*" || rm === m) && re.test(rest)) return step;
  return "other";
}

/** Lifecycle class of an anchor transaction status (SEP-6/24/31 and Anchor Platform 5.x status lists). */
export function lifecycleOf(status: unknown): Lifecycle | undefined {
  switch (status) {
    case "incomplete":
      return "started";
    case "pending_user_transfer_start":
    case "pending_user":
    case "pending_customer_info_update":
    case "pending_transaction_info_update":
    case "pending_sender":
      return "pending_user";
    case "pending_user_transfer_complete":
    case "pending_anchor":
    case "pending_external":
    case "pending_stellar":
    case "pending_trust":
    case "pending_receiver":
    case "on_hold":
      return "pending_anchor";
    case "completed":
      return "completed";
    case "refunded":
      return "refunded";
    case "expired":
      return "expired";
    case "error":
    case "no_market":
    case "too_small":
    case "too_large":
      return "failed";
    default:
      return undefined;
  }
}

/** Transfer kind of an anchor transaction `kind` (`exchange` variants fold); undefined when unknown. */
export function kindOf(kind: unknown): Kind | undefined {
  switch (kind) {
    case "deposit":
    case "deposit-exchange":
      return "deposit";
    case "withdrawal":
    case "withdrawal-exchange":
    case "withdraw":
      return "withdraw";
    case "receive":
      return "receive";
    default:
      return undefined;
  }
}
