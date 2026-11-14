// SPDX-License-Identifier: Apache-2.0
package collectortests

import (
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

const configPath = "../config/collector.yaml"

// lintConfig enforces the rules of wire-formats §g.1 and ADR-0009 on a
// Collector configuration. It is the config lint (C-107).
func lintConfig(cfg map[string]any) []error {
	var errs []error
	fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }

	section := func(name string) map[string]any { m, _ := cfg[name].(map[string]any); return m }
	typeOf := func(id string) string { t, _, _ := strings.Cut(id, "/"); return t }

	// Components that must never be configured.
	for _, sec := range []string{"receivers", "processors", "exporters", "connectors", "extensions"} {
		for id := range section(sec) {
			switch typeOf(id) {
			case "batch", "failover", "loadbalancing", "headers_setter", "groupbytrace", "tail_sampling", "file", "debug":
				fail("%s %q is forbidden", sec, id)
			}
		}
	}

	// No exporter-side batching; persistent queue on the writer exporter.
	exporters := section("exporters")
	storages := map[string]bool{}
	for id, raw := range section("extensions") {
		if typeOf(id) == "file_storage" {
			storages[id] = true
			ext, _ := raw.(map[string]any)
			if ext["fsync"] != true {
				fail("extension %s: fsync must be true", id)
			}
		}
	}
	for id, raw := range exporters {
		exp, _ := raw.(map[string]any)
		q, _ := exp["sending_queue"].(map[string]any)
		if _, ok := q["batch"]; ok {
			fail("exporter %s: sending_queue.batch is forbidden (byte-identical retries, §g.3)", id)
		}
		if _, ok := exp["batch"]; ok {
			fail("exporter %s: batch is forbidden", id)
		}
		if typeOf(id) == "otlp_http" || typeOf(id) == "otlphttp" {
			if q["enabled"] != true || !storages[fmt.Sprint(q["storage"])] {
				fail("exporter %s: sending_queue must be enabled with a file_storage", id)
			}
			if q["sizer"] != "bytes" {
				fail("exporter %s: sending_queue.sizer must be bytes (the queue is bounded in bytes, C-114)", id)
			}
			tls, _ := exp["tls"].(map[string]any)
			for _, k := range []string{"ca_file", "cert_file", "key_file"} {
				if tls[k] == nil || tls[k] == "" {
					fail("exporter %s: tls.%s required (mutual TLS to the writers)", id, k)
				}
			}
			if tls["insecure"] == true || tls["insecure_skip_verify"] == true {
				fail("exporter %s: TLS verification must not be disabled", id)
			}
		} else {
			fail("exporter %s: only otlp_http is allowed", id)
		}
	}

	// Receivers: OTLP with metadata, loopback by default.
	loopback := regexp.MustCompile(`^(\$\{env:[A-Z0-9_]+:-)?(127\.0\.0\.1|localhost|\[::1\]):\d+\}?$`)
	for id, raw := range section("receivers") {
		if typeOf(id) != "otlp" {
			fail("receiver %s: only otlp is allowed", id)
			continue
		}
		rcv, _ := raw.(map[string]any)
		protos, _ := rcv["protocols"].(map[string]any)
		for _, p := range []string{"grpc", "http"} {
			pc, ok := protos[p].(map[string]any)
			if !ok {
				fail("receiver %s: protocol %s missing", id, p)
				continue
			}
			if pc["include_metadata"] != true {
				fail("receiver %s/%s: include_metadata must be true (§f.4)", id, p)
			}
			if !loopback.MatchString(fmt.Sprint(pc["endpoint"])) {
				fail("receiver %s/%s: endpoint %v must default to loopback", id, p, pc["endpoint"])
			}
		}
	}

	// Pipelines.
	service, _ := cfg["service"].(map[string]any)
	pipelines, _ := service["pipelines"].(map[string]any)
	connectors := section("connectors")
	for id, raw := range pipelines {
		p, _ := raw.(map[string]any)
		signal := typeOf(id)
		strs := func(key string) []string {
			var out []string
			l, _ := p[key].([]any)
			for _, v := range l {
				out = append(out, fmt.Sprint(v))
			}
			return out
		}
		receivers, processors, exps := strs("receivers"), strs("processors"), strs("exporters")
		switch signal {
		case "logs", "profiles":
			fail("pipeline %s: no %s pipeline may exist (/v1/logs must be refused)", id, signal)
		case "traces":
			for _, e := range exps {
				if _, isConnector := connectors[e]; !isConnector || typeOf(e) != "signal_to_metrics" {
					fail("pipeline %s: traces may only feed signal_to_metrics, not %s", id, e)
				}
			}
		}
		fromReceiver := slices.ContainsFunc(receivers, func(r string) bool { _, ok := section("receivers")[r]; return ok })
		if fromReceiver && (len(processors) < 2 || typeOf(processors[0]) != "memory_limiter" || typeOf(processors[1]) != "scfsanitize") {
			fail("pipeline %s: processors must start with memory_limiter, scfsanitize; got %v", id, processors)
		}
	}
	return errs
}

func loadConfig(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := yaml.Unmarshal(b, &cfg); err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestConfigLint(t *testing.T) {
	for _, err := range lintConfig(loadConfig(t)) {
		t.Error(err)
	}
}

// The lint must catch each forbidden change.
func TestConfigLintCatchesViolations(t *testing.T) {
	get := func(m map[string]any, path ...string) map[string]any {
		for _, p := range path {
			m = m[p].(map[string]any)
		}
		return m
	}
	tests := map[string]func(cfg map[string]any){
		"exporter batching": func(cfg map[string]any) {
			get(cfg, "exporters", "otlp_http/writer", "sending_queue")["batch"] = map[string]any{"min_size": 10}
		},
		"batch processor": func(cfg map[string]any) {
			get(cfg, "processors")["batch"] = map[string]any{}
		},
		"logs pipeline": func(cfg map[string]any) {
			get(cfg, "service", "pipelines")["logs"] = map[string]any{"receivers": []any{"otlp"}, "processors": []any{"memory_limiter", "scfsanitize"}, "exporters": []any{"otlp_http/writer"}}
		},
		"traces exported": func(cfg map[string]any) {
			get(cfg, "service", "pipelines", "traces")["exporters"] = []any{"signal_to_metrics", "otlp_http/writer"}
		},
		"fsync off": func(cfg map[string]any) {
			get(cfg, "extensions", "file_storage/queue")["fsync"] = false
		},
		"queue bounded by request count only": func(cfg map[string]any) {
			get(cfg, "exporters", "otlp_http/writer", "sending_queue")["sizer"] = "requests"
		},
		"no queue": func(cfg map[string]any) {
			get(cfg, "exporters", "otlp_http/writer", "sending_queue")["enabled"] = false
		},
		"sanitise not first": func(cfg map[string]any) {
			get(cfg, "service", "pipelines", "metrics")["processors"] = []any{"scfsanitize", "memory_limiter"}
		},
		"public receiver": func(cfg map[string]any) {
			get(cfg, "receivers", "otlp", "protocols", "http")["endpoint"] = "0.0.0.0:4318"
		},
		"no metadata": func(cfg map[string]any) {
			get(cfg, "receivers", "otlp", "protocols", "grpc")["include_metadata"] = false
		},
		"no client certificate": func(cfg map[string]any) {
			delete(get(cfg, "exporters", "otlp_http/writer", "tls"), "cert_file")
		},
		"failover connector": func(cfg map[string]any) {
			get(cfg, "connectors")["failover/writers"] = map[string]any{}
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			cfg := loadConfig(t)
			mutate(cfg)
			if errs := lintConfig(cfg); len(errs) == 0 {
				t.Fatal("lint accepted a forbidden configuration")
			}
		})
	}
}
