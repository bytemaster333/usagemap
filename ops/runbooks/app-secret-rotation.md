# Runbook: Umami `APP_SECRET` rotation

Status: exercised 2026-11-14 (local stack, under load) — see the drill log
Owner: maintainers
Last reviewed: 2026-11-14

`APP_SECRET` is Umami's server secret. It must be **identical on every Umami instance** (C-112(11),
`vendor/umami/README.md`). Umami derives its session ids and visit cache tokens from it, so rotating it is a
**planned event**: every session id and cache token changes at the switch.

Where it comes from: in the local stack `infra/compose/scripts/dev-secrets.sh` creates
`infra/compose/.secrets/umami_app_secret` (32 random bytes, hex) once; the `umami` service reads it from the Compose
secret `/run/secrets/umami_app_secret` in its entrypoint (`infra/compose/compose.yaml`). In production it comes from
SOPS (planned).

## When

- Suspected disclosure of the secret, a handover where the new service operator wants fresh secrets, or a periodic
  rotation decided by the team. Not needed for routine operation.

## Effect on the numbers

- Visits and visitors in progress are split at the switch: a visitor active across it counts as two sessions and two
  visits that day (bounce rate up, durations down for that day).
- The engine proxy's visit memory holds cache tokens minted under the old secret; they are no longer valid after the
  switch (C-112(11)), so the first event of each active visitor starts a new visit.
- **Do it at 00:00 UTC**: the gateway's visitor key `K_day` rotates then anyway (ADR-0007), so no visitor is
  recognised across that boundary in any case and nothing extra is split. Umami's own daily salt rotation
  (`SALT_ROTATION=day`) happens at the same boundary.

## Steps

1. Announce a maintenance window just before 00:00 UTC (no downtime expected beyond a container restart; events wait in
   the spools).
2. Write the new value to the secret store (locally: replace `infra/compose/.secrets/umami_app_secret` — the script
   never overwrites an existing file, so delete it and run `infra/compose/scripts/dev-secrets.sh`).
3. At 00:00 UTC restart **every** Umami instance with the new value, together:
   `$DC up -d --force-recreate umami` — this recreates `umami` and `umami-migrate` and re-runs the chain
   `umami-views-drop` → `umami-migrate` → `umami-views` → `umami` (PostgreSQL is not recreated). Instances with
   different secrets must never run side by side. Check the new value reached the container without printing it:
   `$DC exec -T umami sh -c 'sha256sum < /run/secrets/umami_app_secret'` equals `sha256sum < <secret file>`.
4. Restart the engine proxies so no stale cache tokens are replayed:
   `$DC restart engine-proxy` (the gate re-opens by its own probe: `scf_engine_proxy_bootstrap_gate_open` 1).
5. Verify with `infra/compose/scripts/smoke.sh` (event accepted, replay joins the same visit) and watch
   `scf_gateway_forward_total` return to `delivered`.
6. Annotate the day in the operational record: visit metrics of the boundary are slightly affected.

## Drill

Rotate in the local stack with traffic from the tracker fixtures or the smoke client; record it here and in `README.md`.

**Production note (lean profile).** The secret comes from SOPS (`infra/ansible/scripts/gen-stack-secrets.sh`, written
to `/etc/scf/stack/secrets/umami_app_secret` by the playbook). Compose file secrets are bind mounts of single files:
a file **replaced** by a new one (new inode — the playbook's copy and `rm` + re-create both do this) is seen by a
container only after it is **recreated or restarted**, which step 3 does.

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-14 | Compose, project `scf-tg` (ports 56450–56452), images built from the working tree; not at 00:00 UTC (22:4x UTC) | Under gateway probe traffic (~2 events/s, 70 s): step 2 (`rm` the secret file, `dev-secrets.sh` — a stack-private copy writing to the project's own secrets directory), step 3 (`$DC up -d --force-recreate umami`, 5 s), step 4 (`$DC restart engine-proxy`, < 1 s), step 5 (`smoke.sh` with `KEEP=1` on the running stack) | **pass** — secret fingerprint old `f93b…` → new `07b0…`, the container sees the new one; 133 events accepted, 0 refused, 133/133 stored; gate open again; smoke 127 passed, 2 failed — both failures are the smoke's exact-total checks (`== 3` requests) re-run on a stack that already held earlier points (found 6 and 177 = earlier + the new 3; both points were stored), not a rotation fault; the visit checks passed ("second event of the visit accepted", "2 page views in 1 visit (token replayed)"). |
