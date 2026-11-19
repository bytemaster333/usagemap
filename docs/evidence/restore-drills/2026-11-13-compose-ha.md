# Restore drill results — 2026-11-13 (Compose HA profile)

Only results are published (C-56): pass/fail, timings, restored point, checksums of the check set — never rows.
Source: `infra/compose/ha/tests/run.sh` (run of 2026-11-13 09:56–10:02 UTC), details in
[`../chaos/postgres-ha-2026-11-13.md`](../chaos/postgres-ha-2026-11-13.md).

| Drill | Target | Result | Restore | Ready | amcheck | RLS gates | Expectations | Restored point |
|---|---|---|---|---|---|---|---|---|
| weekly (repo 2, read-only) | latest | PASS | 9.7 s | 11.3 s | 0.4 s | 11/11 | 3/3 | 2026-11-13 09:58:00.804478+00 |
| point in time | 2026-11-13 09:57:08.931124+00 | PASS | 11.2 s | 14.4 s | 0.4 s | 11/11 | 1/1 | 2026-11-13 09:57:06.841589+00 |
| negative control: 4 bundle blobs overwritten | latest | FAIL (stage restore) — as intended | — | — | — | — | — | — |
| after a new full backup | latest | PASS | 10.5 s | 11.9 s | 0.5 s | 11/11 | — | end of archive |
