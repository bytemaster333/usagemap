// SPDX-License-Identifier: Apache-2.0
// Display formatting. One fixed locale ("en-US" digits and grouping) so the figures a tenant sees are the figures the
// tests assert; dates are always shown in UTC because every range and every day in the API is a UTC day (C-86).

const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const ONE_DECIMAL = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const MONTH = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const HOUR = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

export const DASH = "—";

export function fmtInt(n: number | null | undefined): string {
  return n === null || n === undefined ? DASH : INT.format(n);
}

/** A value that is already a percentage (e.g. `bounce_rate_pct` 41.4) → "41.4%". */
export function fmtPct(p: number | null | undefined): string {
  return p === null || p === undefined ? DASH : `${ONE_DECIMAL.format(p)}%`;
}

/** A share in [0, 1] (e.g. `suspect_pageview_share` 0.06) → "6.0%". */
export function fmtShare(s: number | null | undefined): string {
  return s === null || s === undefined ? DASH : `${ONE_DECIMAL.format(s * 100)}%`;
}

/** Seconds → "45 s", "1 min 33 s", "1 h 02 min". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return DASH;
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r === 0 ? `${m} min` : `${m} min ${r} s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

/** Relative change between two periods → "+12.5%", "−3.0%", "0.0%"; null when there is no base to compare with. */
export function fmtDelta(current: number | null | undefined, previous: number | null | undefined) {
  if (current === null || current === undefined || previous === null || previous === undefined)
    return null;
  if (previous === 0) return current === 0 ? "0.0%" : null;
  const d = ((current - previous) / previous) * 100;
  const abs = ONE_DECIMAL.format(Math.abs(d));
  if (abs === "0.0") return "0.0%";
  return d > 0 ? `+${abs}%` : `−${abs}%`;
}

export function fmtDay(iso: string): string {
  return DAY.format(new Date(iso));
}

export function fmtDayTime(iso: string): string {
  return `${DAY_TIME.format(new Date(iso))} UTC`;
}

/** A time-series bucket label for the given unit. */
export function fmtBucket(iso: string, unit: "hour" | "day" | "month"): string {
  const d = new Date(iso);
  if (unit === "hour") return `${DAY.format(d)} ${HOUR.format(d)}`;
  if (unit === "month") return MONTH.format(d);
  return DAY.format(d);
}

/** A short axis label: "14:00", "12 Nov", "Nov 2026". */
export function fmtAxis(iso: string, unit: "hour" | "day" | "month"): string {
  const d = new Date(iso);
  if (unit === "hour") return HOUR.format(d);
  if (unit === "month") return MONTH.format(d);
  return DAY.format(d).replace(/ \d{4}$/, "");
}

/**
 * A half-open range [start, end) as the inclusive days a person reads: "13 Oct 2026 – 11 Nov 2026"; a range that does
 * not sit on UTC midnights (the 24 h preset) is shown with times.
 */
export function fmtRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const midnight = (d: Date) =>
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  if (midnight(s) && midnight(e)) {
    const lastDay = new Date(e.getTime() - 86_400_000);
    return lastDay.getTime() <= s.getTime()
      ? DAY.format(s)
      : `${DAY.format(s)} – ${DAY.format(lastDay)}`;
  }
  return `${fmtDayTime(start)} – ${fmtDayTime(end)}`;
}

let regionNames: Intl.DisplayNames | undefined;
/** ISO 3166-1 alpha-2 → English name; `XX` (unknown, as the gateway reports it) → "Unknown". */
export function countryName(code: string): string {
  if (code === "XX") return "Unknown";
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}
