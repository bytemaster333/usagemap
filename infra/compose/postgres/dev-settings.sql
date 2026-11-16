-- SPDX-License-Identifier: Apache-2.0
-- Platform settings of the LOCAL STACK (compose service dev-settings, run after the migrations on every start). In
-- production an operator_admin sets these through the control plane; here every control plane runs the current code.
-- Idempotent.
BEGIN;
-- C-137, wire-formats §d.3/§e.3: the core accepts the counter-record parts `props` (Stellar event property counts →
-- web_event_property_daily) and `dev` (dev-origin events → web_dev_events); edge_snapshot copies this into the edge
-- snapshot's settings.counter_features, so gateways send them.
UPDATE scf.settings SET value = '["props", "dev"]'::jsonb, updated_at = now()
 WHERE key = 'edge_counter_features' AND value IS DISTINCT FROM '["props", "dev"]'::jsonb;
COMMIT;
NOTIFY scf_edge;
