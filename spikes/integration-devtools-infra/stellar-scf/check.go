// SPDX-License-Identifier: Apache-2.0

// Package main is the spike of `stellar scf`, a Stellar CLI plugin (any
// `stellar-<name>` binary on PATH becomes `stellar <name>`). `check` runs the
// real UsageMap sanitise step (collector/processor/scfsanitizeprocessor)
// in-process on a local OTLP/JSON payload and reports what the platform would
// keep, redact and drop. It makes no network calls and never reads the Stellar
// CLI config directory (identities there hold secret keys).
package main

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/bytemaster333/usagemap/collector/processor/scfsanitizeprocessor"
	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/processor/processortest"
)

// dryRunTenant is a fixed placeholder: the processor needs a tenant id to
// attribute a request, and the dry run belongs to nobody.
const dryRunTenant = "00000000-0000-4000-8000-000000000000"

// Options of one check.
type Options struct {
	// Services is the tenant's declared service list, "*" for any.
	Services string
	// ReceivedAt is "newest" (the newest timestamp in the payload, so a
	// recorded sample checks cleanly), "now", or Unix nanoseconds.
	ReceivedAt string
	// Level is the tenant verification level L0…L3.
	Level string
}

// Series is one kept data point (metrics) or span (traces), already sanitised.
type Series struct {
	Name    string `json:"name"`
	Service string `json:"service"`
	Method  string `json:"method,omitempty"`
	Route   string `json:"route,omitempty"`
	Status  int64  `json:"status,omitempty"`
	Count   uint64 `json:"count"`
}

// Drop is one reason the sanitise step dropped (or redacted) data.
type Drop struct {
	Reason  string `json:"reason"`
	Service string `json:"service"`
	Count   int64  `json:"count"`
}

// Report is the result of a check.
type Report struct {
	Signal       string   `json:"signal"`
	RulesVersion string   `json:"rules_version,omitempty"`
	ReceivedAt   string   `json:"received_at"`
	InputItems   int      `json:"input_items"`
	KeptItems    int      `json:"kept_items"`
	Kept         []Series `json:"kept"`
	// Redacted counts kept items whose route had a value replaced.
	Redacted []Drop `json:"redacted"`
	Dropped  []Drop `json:"dropped"`
	// RemovedAttributes are attribute keys present in the input and absent
	// from everything kept. Values are never printed.
	RemovedAttributes []string `json:"removed_attributes"`
	// Hints say how to fix what was dropped or left without a route.
	Hints []string `json:"hints"`
}

// DroppedItems is the number of input items not kept.
func (r *Report) DroppedItems() int64 {
	var n int64
	for _, d := range r.Dropped {
		n += d.Count
	}
	return n
}

// Check parses an OTLP/JSON payload (metrics or traces) and runs it through
// the sanitise step exactly as the Collector would for one request.
func Check(payload []byte, opts Options) (*Report, error) {
	switch detectSignal(payload) {
	case "metrics":
		md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(payload)
		if err != nil {
			return nil, fmt.Errorf("not valid OTLP/JSON metrics: %w", err)
		}
		return checkMetrics(md, opts)
	case "traces":
		td, err := (&ptrace.JSONUnmarshaler{}).UnmarshalTraces(payload)
		if err != nil {
			return nil, fmt.Errorf("not valid OTLP/JSON traces: %w", err)
		}
		return checkTraces(td, opts)
	}
	return nil, errors.New("payload is neither OTLP/JSON metrics (resourceMetrics) nor traces (resourceSpans)")
}

func detectSignal(b []byte) string {
	s := string(b)
	m, t := strings.Index(s, `"resourceMetrics"`), strings.Index(s, `"resourceSpans"`)
	switch {
	case m >= 0 && (t < 0 || m < t):
		return "metrics"
	case t >= 0:
		return "traces"
	}
	return ""
}

func requestContext(opts Options, newest int64) (context.Context, string, error) {
	var recv int64
	label := ""
	switch v := strings.TrimSpace(opts.ReceivedAt); v {
	case "", "newest":
		recv, label = newest, "newest timestamp in the payload"
		if recv <= 0 {
			recv, label = time.Now().UnixNano(), "now (payload has no timestamps)"
		}
	case "now":
		recv, label = time.Now().UnixNano(), "now"
	default:
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			return nil, "", fmt.Errorf("--received-at must be newest, now or Unix nanoseconds, got %q", v)
		}
		recv, label = n, "given"
	}
	services := opts.Services
	if strings.TrimSpace(services) == "" {
		services = "*"
	}
	level := opts.Level
	if level == "" {
		level = "L1"
	}
	md := client.NewMetadata(map[string][]string{
		scfsanitizeprocessor.MetaTenantID:        {dryRunTenant},
		scfsanitizeprocessor.MetaAllowedServices: {services},
		scfsanitizeprocessor.MetaReceivedAt:      {strconv.FormatInt(recv, 10)},
		scfsanitizeprocessor.MetaTenantLevel:     {level},
	})
	ctx := client.NewContext(context.Background(), client.Info{Metadata: md})
	return ctx, time.Unix(0, recv).UTC().Format(time.RFC3339) + " (" + label + ")", nil
}

func checkMetrics(in pmetric.Metrics, opts Options) (*Report, error) {
	rep := &Report{Signal: "metrics", InputItems: in.DataPointCount(), Kept: []Series{}, Redacted: []Drop{}, Dropped: []Drop{}}
	inKeys := map[string]struct{}{}
	var newest int64
	forEachMetricPoint(in, func(res pcommon.Map, _ pmetric.Metric, attrs pcommon.Map, ts pcommon.Timestamp) {
		collectKeys(inKeys, res)
		collectKeys(inKeys, attrs)
		newest = max(newest, int64(ts))
	})
	ctx, label, err := requestContext(opts, newest)
	if err != nil {
		return nil, err
	}
	rep.ReceivedAt = label

	f := scfsanitizeprocessor.NewFactory()
	sink := new(consumertest.MetricsSink)
	p, err := f.CreateMetrics(context.Background(), processortest.NewNopSettings(f.Type()), f.CreateDefaultConfig(), sink)
	if err != nil {
		return nil, err
	}
	if err := p.Start(context.Background(), componenttest.NewNopHost()); err != nil {
		return nil, err
	}
	defer func() { _ = p.Shutdown(context.Background()) }()
	if err := p.ConsumeMetrics(ctx, in); err != nil {
		return nil, err
	}

	outKeys := map[string]struct{}{}
	for _, out := range sink.AllMetrics() {
		rms := out.ResourceMetrics()
		for i := 0; i < rms.Len(); i++ {
			r := rms.At(i)
			service := strAttr(r.Resource().Attributes(), "service.name")
			sms := r.ScopeMetrics()
			for j := 0; j < sms.Len(); j++ {
				sm := sms.At(j)
				for k := 0; k < sm.Metrics().Len(); k++ {
					m := sm.Metrics().At(k)
					if sm.Scope().Name() == scfsanitizeprocessor.ScopeName && m.Name() == scfsanitizeprocessor.MetricIngestDropped {
						dps := m.Sum().DataPoints()
						for d := 0; d < dps.Len(); d++ {
							a := dps.At(d).Attributes()
							rep.addTally(strAttr(a, scfsanitizeprocessor.AttrReason), strAttr(a, "service.name"), dps.At(d).IntValue())
						}
						continue
					}
					collectKeys(outKeys, r.Resource().Attributes())
					forEachPointOf(m, func(attrs pcommon.Map, count uint64) {
						collectKeys(outKeys, attrs)
						rep.KeptItems++
						if v := strAttr(attrs, scfsanitizeprocessor.AttrRulesVersion); v != "" {
							rep.RulesVersion = v
						}
						rep.Kept = append(rep.Kept, Series{
							Name: m.Name(), Service: service, Method: strAttr(attrs, "http.request.method"),
							Route: strAttr(attrs, scfsanitizeprocessor.AttrRoute), Status: intAttr(attrs, "http.response.status_code"),
							Count: count,
						})
					})
				}
			}
		}
	}
	rep.finish(inKeys, outKeys)
	return rep, nil
}

func checkTraces(in ptrace.Traces, opts Options) (*Report, error) {
	rep := &Report{Signal: "traces", InputItems: in.SpanCount(), Kept: []Series{}, Redacted: []Drop{}, Dropped: []Drop{}}
	inKeys := map[string]struct{}{}
	var newest int64
	forEachSpan(in, func(res pcommon.Map, sp ptrace.Span) {
		collectKeys(inKeys, res)
		collectKeys(inKeys, sp.Attributes())
		newest = max(newest, int64(sp.EndTimestamp()))
	})
	ctx, label, err := requestContext(opts, newest)
	if err != nil {
		return nil, err
	}
	rep.ReceivedAt = label

	f := scfsanitizeprocessor.NewFactory()
	sink := new(consumertest.TracesSink)
	p, err := f.CreateTraces(context.Background(), processortest.NewNopSettings(f.Type()), f.CreateDefaultConfig(), sink)
	if err != nil {
		return nil, err
	}
	if err := p.Start(context.Background(), componenttest.NewNopHost()); err != nil {
		return nil, err
	}
	defer func() { _ = p.Shutdown(context.Background()) }()
	if err := p.ConsumeTraces(ctx, in); err != nil {
		return nil, err
	}

	outKeys := map[string]struct{}{}
	for _, out := range sink.AllTraces() {
		forEachSpan(out, func(res pcommon.Map, sp ptrace.Span) {
			a := sp.Attributes()
			if strAttr(a, scfsanitizeprocessor.AttrMarker) == scfsanitizeprocessor.MarkerDropped {
				rep.addTally(strAttr(a, scfsanitizeprocessor.AttrReason), strAttr(a, "service.name"), intAttr(a, scfsanitizeprocessor.AttrDroppedCount))
				return
			}
			collectKeys(outKeys, res)
			collectKeys(outKeys, a)
			rep.KeptItems++
			if v := strAttr(a, scfsanitizeprocessor.AttrRulesVersion); v != "" {
				rep.RulesVersion = v
			}
			rep.Kept = append(rep.Kept, Series{
				Name: "span (SERVER)", Service: strAttr(res, "service.name"), Method: strAttr(a, "http.request.method"),
				Route: strAttr(a, scfsanitizeprocessor.AttrRoute), Status: intAttr(a, "http.response.status_code"), Count: 1,
			})
		})
	}
	rep.finish(inKeys, outKeys)
	return rep, nil
}

func (r *Report) addTally(reason, service string, n int64) {
	d := Drop{Reason: reason, Service: service, Count: n}
	if reason == scfsanitizeprocessor.ReasonRouteRedacted {
		r.Redacted = append(r.Redacted, d)
		return
	}
	r.Dropped = append(r.Dropped, d)
}

// finish merges identical kept series and computes the removed keys.
func (r *Report) finish(inKeys, outKeys map[string]struct{}) {
	type key struct {
		name, service, method, route string
		status                       int64
	}
	merged := map[key]*Series{}
	var order []key
	for _, s := range r.Kept {
		k := key{s.Name, s.Service, s.Method, s.Route, s.Status}
		if m, ok := merged[k]; ok {
			m.Count += s.Count
			continue
		}
		c := s
		merged[k] = &c
		order = append(order, k)
	}
	r.Kept = r.Kept[:0]
	for _, k := range order {
		r.Kept = append(r.Kept, *merged[k])
	}
	// http.route is not removed but re-normalised into scf.route.
	if _, ok := outKeys[scfsanitizeprocessor.AttrRoute]; ok {
		outKeys["http.route"] = struct{}{}
	}
	for k := range inKeys {
		if _, ok := outKeys[k]; !ok {
			r.RemovedAttributes = append(r.RemovedAttributes, k)
		}
	}
	slices.Sort(r.RemovedAttributes)
	if r.RemovedAttributes == nil {
		r.RemovedAttributes = []string{}
	}
	r.Hints = hints(r)
}

// hintFor maps a drop reason to the fix a developer can make.
var hintFor = map[string]string{
	scfsanitizeprocessor.ReasonServiceNotAllowed: "service.name is not declared for this project: register it on the project's API services page in the portal, or pass --services to this check.",
	scfsanitizeprocessor.ReasonMetricNotAllowed:  "only http.server.request.duration (or legacy http.server.duration) is stored; other metrics are dropped by design — filter them in your SDK views to save bandwidth.",
	scfsanitizeprocessor.ReasonClientMetric:      "client-side metrics (http.client.*, rpc.client.*) are not stored yet; outbound RPC calls need the Stellar RPC hook (B4) once the allow-list gains it.",
	scfsanitizeprocessor.ReasonSpanNotServer:     "only SERVER spans count; CLIENT/INTERNAL spans are dropped. Sending metrics instead of traces avoids the bandwidth.",
	scfsanitizeprocessor.ReasonSpanNotLocalRoot:  "only the local-root SERVER span of each request counts; nested SERVER spans are dropped.",
	scfsanitizeprocessor.ReasonTooOld:            "data older than 48 h at receipt is dropped: check the exporter interval and the host clock.",
	scfsanitizeprocessor.ReasonFuture:            "data more than 5 min in the future is dropped: the host clock is ahead.",
	scfsanitizeprocessor.ReasonMalformedPoint:    "malformed points (bad histogram buckets, unit not s/ms, missing service.name) are dropped: check the SDK version.",
}

func hints(r *Report) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, d := range r.Dropped {
		if h, ok := hintFor[d.Reason]; ok && !seen[d.Reason] {
			seen[d.Reason] = true
			out = append(out, d.Reason+": "+h)
		}
	}
	for _, s := range r.Kept {
		if s.Route == "{unknown}" {
			out = append(out, "route {unknown}: the metric point has no http.route; enable your framework's instrumentation (Express, Fastify, Spring, Django…) — url.path is never used for metrics.")
			break
		}
	}
	return out
}

func forEachMetricPoint(md pmetric.Metrics, fn func(res pcommon.Map, m pmetric.Metric, attrs pcommon.Map, ts pcommon.Timestamp)) {
	rms := md.ResourceMetrics()
	for i := 0; i < rms.Len(); i++ {
		res := rms.At(i).Resource().Attributes()
		sms := rms.At(i).ScopeMetrics()
		for j := 0; j < sms.Len(); j++ {
			ms := sms.At(j).Metrics()
			for k := 0; k < ms.Len(); k++ {
				m := ms.At(k)
				eachPoint(m, func(attrs pcommon.Map, ts pcommon.Timestamp, _ uint64) { fn(res, m, attrs, ts) })
			}
		}
	}
}

func forEachPointOf(m pmetric.Metric, fn func(attrs pcommon.Map, count uint64)) {
	eachPoint(m, func(attrs pcommon.Map, _ pcommon.Timestamp, count uint64) { fn(attrs, count) })
}

// eachPoint visits every data point; count is the histogram count (1 for
// other point types).
func eachPoint(m pmetric.Metric, fn func(attrs pcommon.Map, ts pcommon.Timestamp, count uint64)) {
	switch m.Type() {
	case pmetric.MetricTypeHistogram:
		dps := m.Histogram().DataPoints()
		for i := 0; i < dps.Len(); i++ {
			fn(dps.At(i).Attributes(), dps.At(i).Timestamp(), dps.At(i).Count())
		}
	case pmetric.MetricTypeExponentialHistogram:
		dps := m.ExponentialHistogram().DataPoints()
		for i := 0; i < dps.Len(); i++ {
			fn(dps.At(i).Attributes(), dps.At(i).Timestamp(), dps.At(i).Count())
		}
	case pmetric.MetricTypeSum:
		dps := m.Sum().DataPoints()
		for i := 0; i < dps.Len(); i++ {
			fn(dps.At(i).Attributes(), dps.At(i).Timestamp(), 1)
		}
	case pmetric.MetricTypeGauge:
		dps := m.Gauge().DataPoints()
		for i := 0; i < dps.Len(); i++ {
			fn(dps.At(i).Attributes(), dps.At(i).Timestamp(), 1)
		}
	case pmetric.MetricTypeSummary:
		dps := m.Summary().DataPoints()
		for i := 0; i < dps.Len(); i++ {
			fn(dps.At(i).Attributes(), dps.At(i).Timestamp(), dps.At(i).Count())
		}
	}
}

func forEachSpan(td ptrace.Traces, fn func(res pcommon.Map, sp ptrace.Span)) {
	rss := td.ResourceSpans()
	for i := 0; i < rss.Len(); i++ {
		res := rss.At(i).Resource().Attributes()
		sss := rss.At(i).ScopeSpans()
		for j := 0; j < sss.Len(); j++ {
			sps := sss.At(j).Spans()
			for k := 0; k < sps.Len(); k++ {
				fn(res, sps.At(k))
			}
		}
	}
}

func collectKeys(dst map[string]struct{}, m pcommon.Map) {
	for k := range m.All() {
		dst[k] = struct{}{}
	}
}

func strAttr(m pcommon.Map, k string) string {
	if v, ok := m.Get(k); ok && v.Type() == pcommon.ValueTypeStr {
		return v.Str()
	}
	return ""
}

func intAttr(m pcommon.Map, k string) int64 {
	if v, ok := m.Get(k); ok && v.Type() == pcommon.ValueTypeInt {
		return v.Int()
	}
	return 0
}
