// SPDX-License-Identifier: Apache-2.0

// Package dashboards defines the Grafana dashboards D1–D14 of the monitoring plan §4.3 as code and renders them to
// ops/dashboards/*.json, which Grafana provisions read-only from the repository (ADR-0022). `go test` fails when the
// committed JSON differs from the code (`scf-ops dashboards -out ops/dashboards` regenerates it). Panels use only
// metrics that exist (the services' metrics as built, the recording rules in ops/alerts, standard exporters);
// signals that do not exist yet are listed in a note panel with the metric they need (ops/alerts/coverage.json). No
// panel shows an address, a User-Agent, a visitor path, a token or per-visitor data; tenant identifiers do not
// appear at all.
package dashboards

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Query is one PromQL target.
type Query struct{ Expr, Legend string }

// Panel is one panel.
type Panel struct {
	Title, Type, Unit, Text, Desc string
	Queries                       []Query
	Width                         int // grid columns of 24 (default 12)
	Thresholds                    []float64
	Max                           *float64
}

// Dashboard is one dashboard.
type Dashboard struct {
	UID, Title, Description string
	From                    string // default now-6h
	Panels                  []Panel
}

func q(expr, legend string) Query { return Query{expr, legend} }

func ts(title, unit string, qs ...Query) Panel {
	return Panel{Title: title, Type: "timeseries", Unit: unit, Queries: qs}
}

func stat(title, unit string, qs ...Query) Panel {
	return Panel{Title: title, Type: "stat", Unit: unit, Queries: qs, Width: 6}
}

func note(title, md string) Panel { return Panel{Title: title, Type: "text", Text: md, Width: 24} }

func one() *float64 { v := 1.0; return &v }

// All returns D1–D14.
func All() []Dashboard {
	return []Dashboard{
		{UID: "scf-d01-slo", Title: "D1 SLO overview", From: "now/M",
			Description: "Probe-based headline (C-78) and the figures published next to it; month to date by default.",
			Panels: []Panel{
				{Title: "Ingest availability (headline, month to date)", Type: "stat", Unit: "percentunit", Width: 6, Thresholds: []float64{0.999, 0.9999},
					Queries: []Query{q(`1 - avg_over_time(scf:probe_quorum:bad{kind="round",target="ingest"}[$__range])`, "ingest")}},
				{Title: "Ingest error budget remaining (4.38 min/month; lean profile 3.65 h)", Type: "stat", Unit: "percentunit", Width: 6, Thresholds: []float64{0, 0.5},
					Queries: []Query{q(`1 - sum_over_time(scf:probe_quorum:bad{kind="round",target="ingest"}[$__range]) / (scalar(slo:error_budget:ratio{sloth_id="ingest-availability"}) * days_in_month() * 2880)`, "remaining")}},
				{Title: "Dashboard availability (month to date)", Type: "stat", Unit: "percentunit", Width: 6, Thresholds: []float64{0.99, 0.999},
					Queries: []Query{q(`1 - avg_over_time(scf:probe_quorum:bad{kind="journey",target="dashboard"}[$__range])`, "dashboard")}},
				{Title: "Dashboard error budget remaining (43.8 min/month; lean profile 3.65 h)", Type: "stat", Unit: "percentunit", Width: 6, Thresholds: []float64{0, 0.5},
					Queries: []Query{q(`1 - sum_over_time(scf:probe_quorum:bad{kind="journey",target="dashboard"}[$__range]) / (scalar(slo:error_budget:ratio{sloth_id="dashboard-availability"}) * days_in_month() * 2880)`, "remaining")}},
				{Title: "Per ingest hostname (first attempt, no retry)", Type: "stat", Unit: "percentunit", Width: 8, Thresholds: []float64{0.99, 0.9999},
					Queries: []Query{q(`1 - avg_over_time(scf:probe_quorum:bad{kind="host"}[$__range])`, "{{target}}")}},
				{Title: "Per edge node (direct)", Type: "stat", Unit: "percentunit", Width: 8, Thresholds: []float64{0.99, 0.9999},
					Queries: []Query{q(`1 - avg_over_time(scf:probe_quorum:bad{kind="node"}[$__range])`, "{{target}}")}},
				{Title: "Server-side ratio and OTLP probe", Type: "stat", Unit: "percentunit", Width: 8,
					Queries: []Query{q(`avg_over_time(scf:ingest_server_availability:ratio_rate5m[$__range])`, "server-side (accepted ÷ valid)"),
						q(`1 - avg_over_time(scf:probe_quorum:bad{kind="otlp"}[$__range])`, "OTLP probe")}},
				ts("Burn rate (× budget)", "none",
					q(`slo:sli_error:ratio_rate1h{sloth_id="ingest-availability"} / scalar(slo:error_budget:ratio{sloth_id="ingest-availability"})`, "ingest 1h"),
					q(`slo:sli_error:ratio_rate6h{sloth_id="ingest-availability"} / scalar(slo:error_budget:ratio{sloth_id="ingest-availability"})`, "ingest 6h"),
					q(`slo:sli_error:ratio_rate3d{sloth_id="ingest-availability"} / scalar(slo:error_budget:ratio{sloth_id="ingest-availability"})`, "ingest 3d"),
					q(`slo:sli_error:ratio_rate1h{sloth_id="dashboard-availability"} / scalar(slo:error_budget:ratio{sloth_id="dashboard-availability"})`, "dashboard 1h")),
				ts("Probe votes (1 = source records bad)", "none", q(`scf:probe_source_vote:bad{kind="round"}`, "{{group}}")),
				ts("Rounds decided by fewer than three sources", "none",
					q(`scf:probe_quorum:voters{kind="round",target="ingest"}`, "voting sources")),
				ts("Records discarded at the 72-hour cap", "short",
					q(`sum(increase(scf_gateway_forward_total{outcome="expired_72h"}[1h]))`, "web records / h"),
					q(`sum(increase(scf_ingest_dropped{reason="undeliverable_72h"}[1h]))`, "OTLP points / h")),
				ts("Spool accounting per node (since start)", "short", q(`scf_gateway_spool_events`, "{{instance}} {{counter}}")),
				note("Not yet measured", "Freshness (SLO-3) needs `scf_freshness_canary_visible_total`; the durability reconciliation per node (C-76) needs the `durability_reconcile` job. See `ops/alerts/coverage.json`."),
			}},
		{UID: "scf-d02-edge", Title: "D2 Edge ingest", Panels: []Panel{
			ts("Requests by route and status", "reqps", q(`sum by (route, status) (rate(scf_gateway_requests_total[5m]))`, "{{route}} {{status}}")),
			ts("Time to answer (p50 / p95 / p99)", "s",
				q(`histogram_quantile(0.5, sum by (le, route) (rate(scf_gateway_request_duration_seconds_bucket{route=~"events|challenge"}[5m])))`, "p50 {{route}}"),
				q(`histogram_quantile(0.95, sum by (le, route) (rate(scf_gateway_request_duration_seconds_bucket{route=~"events|challenge"}[5m])))`, "p95 {{route}}"),
				q(`histogram_quantile(0.99, sum by (le, route) (rate(scf_gateway_request_duration_seconds_bucket{route=~"events|challenge"}[5m])))`, "p99 {{route}}")),
			ts("5xx and 429/503 per node", "reqps",
				q(`sum by (instance, status) (rate(scf_gateway_requests_total{status=~"5..|429"}[5m]))`, "{{instance}} {{status}}")),
			ts("Server-side availability (accepted ÷ valid)", "percentunit", q(`scf:ingest_server_availability:ratio_rate5m`, "5m")),
			ts("Gateways up and live edge nodes seen", "none", q(`up{job="gateway"}`, "up {{instance}}"), q(`scf_gateway_live_edge_nodes`, "live peers {{instance}}")),
			ts("Health controller: node verdict and DNS members", "none",
				q(`max by (node) (scf_health_controller_node_up)`, "up {{node}}"),
				q(`min by (hostname, type) (scf_health_controller_record_members)`, "{{hostname}} {{type}}")),
			ts("Health controller: DNS writes and provider state", "none",
				q(`sum by (provider, reason) (increase(scf_health_controller_dns_writes_total[1h]))`, "{{provider}} {{reason}}"),
				q(`max by (provider) (scf_health_controller_provider_up)`, "up {{provider}}")),
			ts("Probe latency per source", "s", q(`scf_probe_last_latency_seconds{kind="round"}`, "{{source}}")),
		}},
		{UID: "scf-d03-spool", Title: "D3 Spool and forwarder", Panels: []Panel{
			{Title: "Oldest spooled record (marks 1 h / 6 h / 24 h / 72 h)", Type: "timeseries", Unit: "s", Thresholds: []float64{3600, 21600, 86400, 259200},
				Queries: []Query{q(`scf_gateway_spool_oldest_age_seconds`, "{{instance}}")}},
			ts("Spool size", "bytes", q(`scf_gateway_spool_bytes`, "{{instance}}")),
			ts("Spool records queued / pending", "short", q(`scf_gateway_spool_queued`, "queued {{instance}}"), q(`scf_gateway_spool_pending`, "pending {{instance}}")),
			ts("Forward outcomes per core", "ops", q(`sum by (kind, outcome, core) (rate(scf_gateway_forward_total[5m]))`, "{{kind}} {{outcome}} {{core}}")),
			ts("Forward failures by error kind", "ops", q(`sum by (core, error_kind) (rate(scf_gateway_forward_total{outcome=~"core_failed|refused"}[5m]))`, "{{core}} {{error_kind}}")),
			ts("Engine bot drops and engine rejections (delivered, C-69)", "ops",
				q(`sum by (outcome) (rate(scf_gateway_forward_total{outcome=~"acked_engine_bot|acked_engine_rejected"}[5m]))`, "{{outcome}}")),
			ts("Spool accounting: fsynced vs acknowledged + expired", "short",
				q(`sum by (instance) (scf_gateway_spool_events{counter="fsynced"})`, "fsynced {{instance}}"),
				q(`sum by (instance) (scf_gateway_spool_events{counter=~"acked_.*|expired_72h"}) + sum by (instance) (scf_gateway_spool_queued)`, "acked + expired + queued {{instance}}")),
			ts("Spool durable / corrupt frames", "none", q(`scf_gateway_spool_durable`, "durable {{instance}}"), q(`scf_gateway_spool_corrupt_frames`, "corrupt {{instance}}")),
			note("Not yet measured", "Spool cap (`scf_gateway_spool_max_bytes`), fsync latency and ambiguous retries (`scf_gateway_forward_ambiguous_retries_total`) are not exported yet."),
		}},
		{UID: "scf-d04-verdicts", Title: "D4 Verdicts and rejections (platform level)", Panels: []Panel{
			ts("Events by verdict", "ops", q(`sum by (verdict) (rate(scf_gateway_events_total[5m]))`, "{{verdict}}")),
			{Title: "Verified share (all tenants)", Type: "timeseries", Unit: "percentunit", Max: one(),
				Queries: []Query{q(`scf:gateway_verified_share:ratio_rate1h`, "verified share 1h")}},
			ts("Reason codes (suspect and rejected)", "ops", q(`sum by (reason) (rate(scf_gateway_reasons_total[5m]))`, "{{reason}}")),
			ts("Dropped or refused events by label", "ops", q(`sum by (label) (rate(scf_gateway_drops_total[5m]))`, "{{label}}")),
			ts("Snapshot age and sequence per node", "s", q(`scf_gateway_snapshot_age_seconds`, "age {{instance}}")),
			ts("Key exchange conflicts and keys held", "none", q(`scf_gateway_keyx_conflicts`, "conflicts {{instance}} {{kind}}"),
				q(`scf_gateway_keys_held`, "held {{instance}}"), q(`scf_gateway_keys_current`, "current {{instance}}")),
			ts("Multiplicity cells and evictions", "short", q(`scf_gateway_multiplicity_cells`, "cells {{instance}}"), q(`scf_gateway_multiplicity_evicted`, "evicted {{instance}}")),
			ts("Range-list entries by class", "short", q(`scf_gateway_rangelist_entries`, "{{instance}} {{class}}")),
		}},
		{UID: "scf-d05-otlp", Title: "D5 OTLP pipeline", Panels: []Panel{
			{Title: "Collector queue fill (bytes)", Type: "timeseries", Unit: "percentunit", Thresholds: []float64{0.5, 0.8}, Max: one(),
				Queries: []Query{q(`scf:collector_queue_fill:ratio`, "{{instance}}")}},
			ts("Collector export failures", "short", q(`sum by (instance) (rate({__name__=~"otelcol_exporter_(send|enqueue)_failed_metric_points(_total)?"}[5m]))`, "{{instance}}")),
			ts("scfsanitize drops by reason", "short", q(`sum by (signal, reason) (rate({__name__=~"otelcol_processor_scfsanitize_dropped(_total)?"}[5m]))`, "{{signal}} {{reason}}")),
			ts("Redactions and merged points", "short", q(`sum by (kind, location) (rate({__name__=~"otelcol_processor_scfsanitize_redactions(_total)?"}[5m]))`, "{{kind}} {{location}}"),
				q(`sum(rate({__name__=~"otelcol_processor_scfsanitize_merged_points(_total)?"}[5m]))`, "merged")),
			ts("Writer requests by code", "reqps", q(`sum by (code) (rate(scf_writer_requests_total[5m]))`, "{{code}}")),
			ts("Writer points by outcome", "short", q(`sum by (outcome) (rate(scf_writer_points_total[5m]))`, "{{outcome}}")),
			ts("Writer data-quality drops by reason", "short", q(`sum by (reason) (rate(scf_ingest_dropped[5m]))`, "{{reason}}")),
			ts("Tenant transactions by outcome", "ops", q(`sum by (outcome) (rate(scf_writer_tenant_transactions_total[5m]))`, "{{outcome}}")),
			ts("Writer listener and database", "none", q(`scf_writer_listener_open`, "listener {{instance}}"), q(`scf_writer_database_up`, "database {{instance}}")),
			ts("Writer TLS handshake errors", "short", q(`sum by (instance) (rate(scf_writer_tls_handshake_errors_total[5m]))`, "{{instance}}")),
		}},
		{UID: "scf-d06-postgres", Title: "D6 PostgreSQL and HA", Panels: []Panel{
			ts("Patroni leader", "none", q(`patroni_primary`, "{{instance}}")),
			ts("Replication lag", "s", q(`pg_replication_lag_seconds`, "{{instance}}")),
			ts("Connections vs max", "percentunit", q(`sum by (instance) (pg_stat_activity_count) / max by (instance) (pg_settings_max_connections)`, "{{instance}}")),
			ts("WAL archiver", "short", q(`increase(pg_stat_archiver_failed_count[1h])`, "failed/h {{instance}}"), q(`pg_stat_archiver_last_archive_age`, "last archive age {{instance}}")),
			ts("Database size", "bytes", q(`pg_database_size_bytes`, "{{instance}} {{datname}}")),
			ts("etcd members with a leader", "none", q(`etcd_server_has_leader`, "{{instance}}")),
		}},
		{UID: "scf-d07-engine", Title: "D7 Engine and engine proxy", Panels: []Panel{
			ts("Engine proxy up", "none", q(`up{job="engine-proxy"}`, "{{instance}}")),
			ts("Requests by caller role and status", "reqps", q(`sum by (role, code) (rate(scf_engine_proxy_requests_total[5m]))`, "{{role}} {{code}}")),
			ts("Mean request time by route", "s", q(`sum by (route) (rate(scf_engine_proxy_request_duration_seconds_sum[5m])) / sum by (route) (rate(scf_engine_proxy_request_duration_seconds_count[5m]))`, "{{route}}")),
			ts("Denials by reason", "short", q(`sum by (node, role, reason) (increase(scf_engine_proxy_denials_total[10m]))`, "{{node}} {{role}} {{reason}}")),
			{Title: "Visit-token hit rate (C-74)", Type: "timeseries", Unit: "percentunit", Max: one(),
				Queries: []Query{q(`scf:engine_proxy_visit_hit:ratio_rate1h`, "hit rate 1h")}},
			ts("Replays refused (30-minute rule, C-99) and purges", "short",
				q(`sum(rate(scf_engine_proxy_visit_replays_refused_total[5m]))`, "replays refused"),
				q(`sum(rate(scf_engine_proxy_visit_purges_total[5m]))`, "purges")),
			ts("Visit tokens held", "short", q(`scf_engine_proxy_visit_tokens`, "{{instance}}")),
			ts("Upstream errors and /api/send rejections", "short",
				q(`sum by (upstream, kind) (rate(scf_engine_proxy_upstream_errors_total[5m]))`, "{{upstream}} {{kind}}"),
				q(`sum by (reason) (rate(scf_engine_proxy_send_rejected_total[5m]))`, "send rejected {{reason}}")),
			ts("Bootstrap gate", "none", q(`scf_engine_proxy_bootstrap_gate_open`, "gate open {{instance}}")),
		}},
		{UID: "scf-d08-control-plane", Title: "D8 Control plane and portal", Panels: []Panel{
			ts("Signed-in journey result per source (1 = bad)", "none", q(`scf_probe_last_bad{kind="journey"}`, "{{source}}")),
			ts("Journey duration per source", "s", q(`scf_probe_last_latency_seconds{kind="journey"}`, "{{source}}")),
			ts("Snapshot publication: age at the edges", "s", q(`max(scf_gateway_snapshot_age_seconds)`, "oldest snapshot")),
			note("Not yet measured", "The control plane exposes no `/metrics` yet: requests and errors by route class, auth events, sessions and key events need `scf_cp_*` metrics (see `ops/alerts/coverage.json`)."),
		}},
		{UID: "scf-d09-jobs", Title: "D9 Jobs", Panels: []Panel{
			ts("Time since last success per job", "s", q(`time() - scf_job_last_success_timestamp_seconds`, "{{job_name}}")),
			ts("Last run duration", "s", q(`scf_job_last_duration_seconds`, "{{job_name}}")),
			ts("Runs by outcome", "short", q(`sum by (job_name, outcome) (increase(scf_job_runs_total[1h]))`, "{{job_name}} {{outcome}}")),
			ts("Units of work by outcome", "short", q(`sum by (job_name, outcome) (increase(scf_job_units_total[1h]))`, "{{job_name}} {{outcome}}")),
			ts("Anomalies", "short", q(`sum by (job_name, reason) (increase(scf_job_anomalies_total[1h]))`, "{{job_name}} {{reason}}")),
			ts("Running", "none", q(`scf_job_running`, "{{job_name}} {{instance}}")),
		}},
		{UID: "scf-d10-security", Title: "D10 Security", Panels: []Panel{
			ts("Engine-proxy denials (excluding the bootstrap gate)", "short", q(`sum by (node, role, reason) (increase(scf_engine_proxy_denials_total{reason!="gate_closed"}[1h]))`, "{{node}} {{role}} {{reason}}")),
			ts("Snapshot signature failures and rollbacks refused", "short",
				q(`sum by (instance, reason) (scf_gateway_snapshot_verify_failures)`, "{{instance}} {{reason}}"),
				q(`scf_gateway_snapshot_rollback_refused_total`, "rollback {{instance}}")),
			ts("Log scanner findings by class", "short", q(`sum by (class) (increase(scf_log_pii_findings_total[1h]))`, "{{class}}")),
			ts("Log scanner: lines and last success", "short", q(`rate(scf_log_scan_lines_total[15m])`, "lines/s"), q(`time() - scf_log_scan_last_success_timestamp_seconds`, "age of last scan")),
			ts("Umami 401/403/404 to tenant-scoped calls", "short", q(`sum by (role, code) (increase(scf_engine_proxy_requests_total{role=~"provisioner|reader",code=~"401|403|404"}[1h]))`, "{{role}} {{code}}")),
			ts("DNS writes by the health controller", "short", q(`sum by (provider, reason) (increase(scf_health_controller_dns_writes_total[1h]))`, "{{provider}} {{reason}}")),
			ts("Core dumps disabled and key memory locked", "none", q(`scf_gateway_core_dumps_disabled`, "no core dumps {{instance}}"), q(`scf_gateway_keys_mlocked`, "mlocked {{instance}}")),
			note("Not yet measured", "Isolation canaries, audit chain and anchor, operator activity, key use, CT findings, tracker hash drift, egress drops and listener scans need the metrics listed in `ops/alerts/coverage.json`."),
		}},
		{UID: "scf-d11-backups", Title: "D11 Backups and DR", Panels: []Panel{
			ts("WAL archive failures and age", "short", q(`increase(pg_stat_archiver_failed_count[1h])`, "failed/h {{instance}}"), q(`pg_stat_archiver_last_archive_age`, "age {{instance}}")),
			note("Not yet measured", "Backup age per repository, `pgbackrest check`/`verify`, logical dump age and restore-drill results need `scf_backup_*` and `scf_restore_drill_*` (see `ops/alerts/coverage.json`)."),
		}},
		{UID: "scf-d12-capacity", Title: "D12 Capacity", From: "now-7d", Panels: []Panel{
			{Title: "Web events per day vs 1,000,000 design and 10× tested", Type: "timeseries", Unit: "short", Thresholds: []float64{1e6, 5e6, 1e7},
				Queries: []Query{q(`sum(increase(scf_gateway_events_total[1d]))`, "events/day")}},
			{Title: "OTLP points per day", Type: "timeseries", Unit: "short", Thresholds: []float64{1e6, 5e6, 1e7},
				Queries: []Query{q(`sum(increase(scf_writer_points_total{outcome="received"}[1d]))`, "points/day")}},
			ts("CPU busy per host", "percentunit", q(`1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))`, "{{instance}}")),
			ts("Memory available", "bytes", q(`node_memory_MemAvailable_bytes`, "{{instance}}")),
			ts("Disk free and predicted in 24 h", "bytes", q(`node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}`, "{{instance}} {{mountpoint}}"),
				q(`predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[6h], 86400)`, "in 24 h {{instance}} {{mountpoint}}")),
			ts("Database size growth", "bytes", q(`sum by (instance) (pg_database_size_bytes)`, "{{instance}}")),
		}},
		{UID: "scf-d13-hosts", Title: "D13 Hosts, network and monitoring", Panels: []Panel{
			ts("Targets up by job", "none", q(`sum by (job) (up)`, "{{job}} up"), q(`count by (job) (up)`, "{{job}} total")),
			ts("NTP offset", "s", q(`node_timex_offset_seconds`, "{{instance}}")),
			ts("Probe sources voting", "none", q(`scf_probe_self_check_ok`, "{{source}}")),
			ts("Probe raw-store errors", "short", q(`sum by (source) (increase(scf_probe_store_errors_total[1h]))`, "{{source}}")),
			ts("Alertmanager notifications failed", "short", q(`sum by (integration) (increase(alertmanager_notifications_failed_total[1h]))`, "{{integration}}")),
			ts("Watchdog heartbeat age at the status host", "s", q(`time() - scf_status_heartbeat_timestamp_seconds`, "heartbeat age"),
				q(`time() - scf_status_page_generated_timestamp_seconds`, "status page age")),
			note("Not yet measured", "WireGuard handshake age needs `wireguard_latest_handshake_seconds` on every host; reboot and unattended-upgrade state come from node_exporter's textfile collector on the hosts (IaC)."),
		}},
		{UID: "scf-d14-delivery", Title: "D14 Delivery and support", Panels: []Panel{
			note("Where these figures come from", "Patch latency, advisory and dependency-update PR age, the daily-watch check log (C-49) and the support first-response and resolution clocks live in GitHub (issue labels set by `tools/support/run sla`), not in Prometheus. They are reported monthly in `docs/evidence/slo/YYYY-MM.md` and on the support board."),
		}},
	}
}

type grid struct{ X, Y, W, H int }

func render(d Dashboard) map[string]any {
	ds := map[string]any{"type": "prometheus", "uid": "prometheus"}
	var panels []any
	x, y, rowH := 0, 0, 0
	for i, p := range d.Panels {
		w := p.Width
		if w == 0 {
			w = 12
		}
		h := 8
		switch p.Type {
		case "stat":
			h = 5
		case "text":
			h = 3
		}
		if x+w > 24 {
			x, y = 0, y+rowH
			rowH = 0
		}
		panel := map[string]any{
			"id": i + 1, "type": p.Type, "title": p.Title,
			"gridPos": map[string]int{"x": x, "y": y, "w": w, "h": h},
		}
		if p.Desc != "" {
			panel["description"] = p.Desc
		}
		if p.Type == "text" {
			panel["options"] = map[string]any{"mode": "markdown", "content": p.Text}
		} else {
			panel["datasource"] = ds
			var targets []any
			for j, qq := range p.Queries {
				targets = append(targets, map[string]any{"refId": string(rune('A' + j)), "datasource": ds, "expr": qq.Expr,
					"legendFormat": qq.Legend, "range": p.Type != "stat", "instant": p.Type == "stat"})
			}
			panel["targets"] = targets
			defaults := map[string]any{"unit": p.Unit}
			if p.Max != nil {
				defaults["max"] = *p.Max
				defaults["min"] = 0
			}
			if len(p.Thresholds) > 0 {
				steps := []any{map[string]any{"color": "red", "value": nil}}
				colors := []string{"orange", "green", "blue", "purple"}
				if p.Type == "timeseries" { // marks on a growing value: green → orange → red
					steps = []any{map[string]any{"color": "green", "value": nil}}
					colors = []string{"yellow", "orange", "red", "dark-red"}
				}
				for k, v := range p.Thresholds {
					steps = append(steps, map[string]any{"color": colors[k%len(colors)], "value": v})
				}
				defaults["thresholds"] = map[string]any{"mode": "absolute", "steps": steps}
				if p.Type == "timeseries" {
					defaults["custom"] = map[string]any{"thresholdsStyle": map[string]any{"mode": "line"}}
				}
			}
			panel["fieldConfig"] = map[string]any{"defaults": defaults, "overrides": []any{}}
			if p.Type == "stat" {
				panel["options"] = map[string]any{"reduceOptions": map[string]any{"calcs": []string{"lastNotNull"}, "fields": "", "values": false},
					"colorMode": "background", "graphMode": "none", "textMode": "auto"}
			} else {
				panel["options"] = map[string]any{"legend": map[string]any{"displayMode": "list", "placement": "bottom"},
					"tooltip": map[string]any{"mode": "multi", "sort": "desc"}}
			}
		}
		panels = append(panels, panel)
		x += w
		rowH = max(rowH, h)
	}
	from := d.From
	if from == "" {
		from = "now-6h"
	}
	return map[string]any{
		"uid": d.UID, "title": d.Title, "description": d.Description, "tags": []string{"scf", "wsj"},
		"timezone": "utc", "editable": false, "graphTooltip": 1, "schemaVersion": 41, "version": 1,
		"refresh": "1m", "time": map[string]string{"from": from, "to": "now"}, "panels": panels,
		"templating": map[string]any{"list": []any{}}, "annotations": map[string]any{"list": []any{}},
	}
}

// FileName is the dashboard's file name.
func FileName(d Dashboard) string {
	return strings.ToLower(strings.ReplaceAll(strings.SplitN(d.UID, "-", 3)[1]+"-"+strings.SplitN(d.UID, "-", 3)[2], " ", "-")) + ".json"
}

// JSON renders one dashboard.
func JSON(d Dashboard) ([]byte, error) {
	b, err := json.MarshalIndent(render(d), "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// WriteAll writes every dashboard into dir.
func WriteAll(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, d := range All() {
		b, err := JSON(d)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, FileName(d)), b, 0o644); err != nil {
			return fmt.Errorf("%s: %w", d.UID, err)
		}
	}
	return nil
}
