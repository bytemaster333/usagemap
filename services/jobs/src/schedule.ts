// SPDX-License-Identifier: Apache-2.0
// Schedules in UTC (data-model §6.3): hourly at a fixed minute, daily at a fixed time, or every N minutes (aligned to
// multiples of N since the epoch; contract_verification's due items, C-136).

export type Schedule =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "every"; minutes: number };

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The first moment strictly after `now` at which the schedule fires. */
export function nextRun(s: Schedule, now: Date): Date {
  const t = now.getTime();
  if (s.kind === "every") {
    const step = Math.max(1, Math.floor(s.minutes)) * 60_000;
    return new Date((Math.floor(t / step) + 1) * step);
  }
  if (s.kind === "hourly") {
    const hourStart = Math.floor(t / HOUR) * HOUR;
    let next = hourStart + s.minute * 60_000;
    if (next <= t) next += HOUR;
    return new Date(next);
  }
  const dayStart = Math.floor(t / DAY) * DAY;
  let next = dayStart + s.hour * HOUR + s.minute * 60_000;
  if (next <= t) next += DAY;
  return new Date(next);
}

/** UTC calendar day of an instant, as YYYY-MM-DD. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus `n` days. */
export function addDays(day: string, n: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));
}

/** Start of a UTC day (YYYY-MM-DD) as a Date. */
export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}
