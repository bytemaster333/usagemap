# engine-proxy

The internal front of Umami on each core node (`docs/contracts/wire-formats.md` §c.5; C-60, C-74, C-99, C-110,
C-112). Go, standard library only. Two binaries from one module:

- `engine-proxy` — the proxy (`cmd/engine-proxy`);
- `umami-bootstrap` — the restartable one-shot Umami bootstrap B1–B5 (`cmd/umami-bootstrap`, wire-formats §j.2).

## What it does

1. **Mutual TLS** (TLS 1.3 only). Every caller presents a node certificate from the private CA. The certificate's
   single **OrganizationalUnit is the role** — `edge`, `reader` or `provisioner` — and its **CommonName is the node
   name** (edge certificates must name an `edge-*` node; node names match `^[a-z0-9][a-z0-9-]{1,31}$`, C-114). An
   optional CRL is honoured; `SIGHUP` reloads certificate, key, CA and CRL without losing the visit memory, and a
   reload takes effect for every caller at once (C-114): revocation is checked in `VerifyConnection`, which also runs
   for resumed TLS sessions; every reload installs fresh session-ticket keys, so tickets issued before it no longer
   resume; and connections opened before it are closed — idle ones at once, busy ones right after their current
   request.
2. **The one deny-list** of §c.5, checked before every allow-list, for every caller (`403`).
3. **Per-caller allow-lists** — method, path and exact query parameters:

   | Role | Allowed |
   |---|---|
   | `edge` | `POST /api/send`; `GET /internal/v1/edge/snapshot`, `POST /internal/v1/edge/counters` (→ control plane, with `X-Scf-Edge-Node: <CN>`; an incoming value is discarded) |
   | `reader` | R1–R4 of §j.3 (`/stats`, `/pageviews`, `/metrics`, `/metrics/expanded` with `startAt`, `endAt`, `timezone=UTC`, optional `tag=v`, the listed `unit`/`type`/`limit` values only); the report reads R6–R8 (`/funnels/stats` with `window` 1–1440 and `steps` = a JSON array of 2–8 `{type: path\|event, value}` objects without filters; `/goals/stats` with `type` path\|event and `value`; `/journeys` with `steps` 2–7 and optional `startStep`/`endStep`; values 1–500 bytes, no control characters; same range parameters); `GET /api/heartbeat` |
   | `provisioner` | B1–B5 and P1–P12 of §j.2 (`/api/me/password` only while the bootstrap gate is closed); `GET /api/heartbeat`; `DELETE /internal/v1/visit-tokens/websites/{id}` |

   Paths must be canonical (no `%`-encoding, `..`, `//`, trailing `/`, upper case); anything else is `403`.
4. **Bootstrap gate** (C-112(7)). After every start, every non-provisioning caller gets `503` + `Retry-After` until a
   B5 check — `POST /api/auth/login` with `admin`/`umami` — was answered `401`. It opens on the worker's forwarded B5
   **or on the proxy's own probe** (at start, every 2 s while closed, every 60 s while open), so a restarted proxy
   re-checks by itself; a later `200` for the seed credentials closes it again. The own probe is stricter (C-114):
   the seed login is already refused after B2, before the provisioning admin exists (B3) and the seed admin is
   deleted (B4), so the probe opens the gate only when the seed login is refused **and** the provisioning identity
   (`EP_PROVISIONER_USER` / `EP_PROVISIONER_PASSWORD_FILE`) can sign in. Without those credentials the probe can only
   close the gate. Metrics: probe counts, errors, the last seed-login status and the last provisioning-login status.
5. **Visit rule** on `POST /api/send` (C-99, C-110(7), C-112(9)): `{token, last_event_ts}` per (website, surrogate);
   `x-umami-cache` is added only when `|timestamp − last_event_ts| ≤ 1800 s`; the `cache` Umami returns is stored and
   `last_event_ts := max(previous, event)`; `cache`, `sessionId`, `visitId` are stripped from the answer. One
   refinement (reported as a contract change): an answer to an event more than 1,800 s **older** than
   `last_event_ts` (a long-delayed backlog event, which got no token and opened its own visit) does not replace the
   current visit's token — otherwise the visitor's next live event would be merged into the old visit.
6. **Request hygiene on `/api/send`**: body ≤ 16 KiB; `type` must be `event`; payload fields limited to those of
   §c.2 (`ip`, `userAgent`, `id`, `title` … → `400`, never forwarded); `x-scf-surrogate-ip` required and inside
   `2001:db8::/32` (so no real address can reach Umami), forwarded in RFC 5952 form; `cf-ipcountry` `XX` when
   missing, otherwise two upper-case letters; the outgoing request is rebuilt from four headers only.
6a. **Event-key de-duplication**: an `x-scf-event-key` header (32 lower-case hex, else `400
   bad_event_key`; never forwarded) is remembered for `EP_DEDUP_WINDOW` (1 h) after Umami accepted the event; a later
   copy of the key gets the first copy's answer (`{}` or `{"beep":"boop"}`) without reaching Umami, a concurrent copy
   waits for the first, and a copy whose first attempt failed is forwarded. At most `EP_DEDUP_MAX_ENTRIES` keys
   (oldest evicted first, counted). Memory only; copies across a core failover or a restart are not recognised.
   Metrics `scf_engine_proxy_send_duplicates_total`, `scf_engine_proxy_event_keys`,
   `scf_engine_proxy_event_key_evictions_total`.
7. **Website deletion**: `DELETE /internal/v1/visit-tokens/websites/{id}` (provisioner, `204`) drops the website's
   tokens and remembers the id for 72 h; P9 forwarded through the proxy purges again.
8. **Memory bounds**: ≤ 500,000 entries (LRU, evictions counted), 30-minute idle TTL, emptied at 00:00 UTC; never
   written to disk.
9. **Observability without personal data**: `/metrics` (Prometheus text), `/healthz`, `/readyz` (gate open) on a
   separate plain-HTTP listener. JSON logs carry node, role, method, route template, status, duration and closed-set
   reasons — never an IP, surrogate, token, User-Agent, path with ids or query string (net/http's own error log is
   reduced to a kind). Tested.

## Configuration

| Variable | Default | |
|---|---|---|
| `EP_LISTEN_ADDR` | `:8443` | mTLS listener |
| `EP_METRICS_ADDR` | `:9464` | `/metrics`, `/healthz`, `/readyz` |
| `EP_TLS_CERT`, `EP_TLS_KEY`, `EP_CLIENT_CA` | required | server certificate, key; CA bundle of node certificates |
| `EP_CLIENT_CRL` | — | CRL (PEM or DER) signed by that CA |
| `EP_UMAMI_URL` | `http://umami:3000` | |
| `EP_CONTROL_PLANE_URL` | — | internal edge API origin, `https://control-plane:8081` with mutual TLS (C-114: the control plane accepts plain HTTP only on loopback); `https` needs `EP_CONTROL_PLANE_TLS_CERT`, `_KEY`, `_CA` (the proxy's client certificate, whose CN the control plane lists in `SCF_INTERNAL_ALLOWED_CLIENTS`) |
| `EP_PROVISIONER_USER` | `scf-provisioner` | provisioning identity for the own bootstrap probe (= `UB_PROVISIONER_USER`) |
| `EP_PROVISIONER_PASSWORD_FILE` | — | its password (same secret as `UB_PROVISIONER_PASSWORD_FILE`); without it only the worker's B5 opens the gate |
| `EP_MAX_ENTRIES` | `500000` | visit-memory bound |
| `EP_DEDUP_WINDOW` | `1h` | how long a delivered event key is remembered |
| `EP_DEDUP_MAX_ENTRIES` | `500000` | event-key memory bound (~100 B per key) |
| `EP_UPSTREAM_TIMEOUT` | `30s` | = `umami_app` statement timeout |
| `EP_GATE_PROBE_CLOSED` / `EP_GATE_PROBE_OPEN` | `2s` / `60s` | own B5 probe interval |
| `EP_LOG_LEVEL` | `info` | |

`umami-bootstrap`: `UB_PROXY_URL`, `UB_TLS_CERT`, `UB_TLS_KEY`, `UB_CA`, `UB_SEED_PASSWORD_FILE` (B2),
`UB_PROVISIONER_PASSWORD_FILE` (B3), `UB_PROVISIONER_USER` (`scf-provisioner`), `UB_DEADLINE` (`5m`). It tries P1
first and resumes from the first incomplete step; a re-run after success does only P1 and B5.

## Tests

```sh
eval "$(mise env -s bash)"
cd services/engine-proxy && go vet ./... && go test -race -count=1 ./...  # unit tests (visit rule, policy, proxy, mTLS, bootstrap)
services/engine-proxy/integration/run.sh                       # real Umami 3.5.0 (our image; project scf-wsi-it, port 56123)
```

The unit tests cover the TLS hardening: a revoked certificate cannot resume a TLS session after a reload; session
tickets from before a reload do not resume; an open keep-alive connection is closed on reload (a busy one after its
request); the own probe keeps the gate closed after B2 until the provisioning identity can sign in.

The integration test shows on the real engine: the gate holds edges until B5; after B1+B2 (done by hand) a probe with
the provisioning credentials keeps the gate closed, and the bootstrapper resumes from there; the bootstrap runs through
the proxy and is a no-op on re-run; one visit survives a clock-hour boundary (10:55 + 11:05) and a 31-minute gap starts a new
visit (stats `visits 2, bounces 1, totaltime 600`), while the same events without the visit memory follow Umami's
clock-hour rule (`totaltime 1860`); answers are `{}`; Umami's own bot check still answers `{"beep":"boop"}`
through the proxy and stores nothing (bot.engine-bot-detection); without the purge an event enters a deleted website (S-01 case
H) and with the purge it is refused; a fresh proxy re-opens its gate by its own probe — only with the provisioning credentials; logs hold no personal data.

Image: `docker build -t usagemap/engine-proxy:dev services/engine-proxy` (distroless static, uid 65532, `HEALTHCHECK`
via `engine-proxy healthcheck`).
