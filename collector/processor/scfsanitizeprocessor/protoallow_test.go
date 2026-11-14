// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"encoding/binary"
	"fmt"
	"math"
	"testing"

	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

// A proto-level allow-list (C-114): the sanitised output is marshalled to the
// OTLP protobuf the exporter queues and sends, and every field present in the
// wire bytes must be on the list below — whatever pdata or a future OTLP
// version adds (entity refs, schema URLs, descriptions, metadata, exemplars,
// events, links, status messages, …) fails the test. Attribute keys are
// checked per level and every string on the wire is handed to check.

type msgKind uint8

const (
	mExportMetrics msgKind = iota
	mExportTraces
	mResourceMetrics
	mResourceSpans
	mResource
	mScopeMetrics
	mScopeSpans
	mScope
	mMetric
	mSum
	mHistogram
	mExpHistogram
	mNumberPoint
	mHistPoint
	mExpPoint
	mExpBuckets
	mSpan
	mStatus
	mKeyValue
	mAnyValue
)

// field describes an allowed field: wire type, sub-message and path name.
type field struct {
	name  string
	wire  int // 0 varint, 1 fixed64, 2 bytes
	msg   msgKind
	isMsg bool
	attrs attrLevel // for repeated KeyValue fields: which key list applies
}

type attrLevel uint8

const (
	levelNone attrLevel = iota
	levelResource
	levelPoint
	levelCounter
	levelSpan
)

var allowedFields = map[msgKind]map[int]field{
	mExportMetrics:   {1: {name: "resource_metrics", wire: 2, msg: mResourceMetrics, isMsg: true}},
	mExportTraces:    {1: {name: "resource_spans", wire: 2, msg: mResourceSpans, isMsg: true}},
	mResourceMetrics: {1: {name: "resource", wire: 2, msg: mResource, isMsg: true}, 2: {name: "scope_metrics", wire: 2, msg: mScopeMetrics, isMsg: true}},
	mResourceSpans:   {1: {name: "resource", wire: 2, msg: mResource, isMsg: true}, 2: {name: "scope_spans", wire: 2, msg: mScopeSpans, isMsg: true}},
	// Resource: attributes only — no dropped count, no entity_refs (3).
	mResource:     {1: {name: "attributes", wire: 2, msg: mKeyValue, isMsg: true, attrs: levelResource}},
	mScopeMetrics: {1: {name: "scope", wire: 2, msg: mScope, isMsg: true}, 2: {name: "metrics", wire: 2, msg: mMetric, isMsg: true}},
	mScopeSpans:   {1: {name: "scope", wire: 2, msg: mScope, isMsg: true}, 2: {name: "spans", wire: 2, msg: mSpan, isMsg: true}},
	// Scope: name and version only.
	mScope: {1: {name: "name", wire: 2}, 2: {name: "version", wire: 2}},
	// Metric: name, unit and the three types we send — no description, metadata, gauge, summary.
	mMetric: {1: {name: "name", wire: 2}, 3: {name: "unit", wire: 2},
		7: {name: "sum", wire: 2, msg: mSum, isMsg: true}, 9: {name: "histogram", wire: 2, msg: mHistogram, isMsg: true},
		10: {name: "exponential_histogram", wire: 2, msg: mExpHistogram, isMsg: true}},
	mSum:          {1: {name: "data_points", wire: 2, msg: mNumberPoint, isMsg: true}, 2: {name: "aggregation_temporality", wire: 0}, 3: {name: "is_monotonic", wire: 0}},
	mHistogram:    {1: {name: "data_points", wire: 2, msg: mHistPoint, isMsg: true}, 2: {name: "aggregation_temporality", wire: 0}},
	mExpHistogram: {1: {name: "data_points", wire: 2, msg: mExpPoint, isMsg: true}, 2: {name: "aggregation_temporality", wire: 0}},
	// Number points exist as scf.ingest.dropped and the Stellar counters (step 4a): int value, no exemplars;
	// flags only on the Stellar counters (FLAG_NO_RECORDED_VALUE).
	mNumberPoint: {7: {name: "attributes", wire: 2, msg: mKeyValue, isMsg: true, attrs: levelCounter},
		2: {name: "start_time_unix_nano", wire: 1}, 3: {name: "time_unix_nano", wire: 1}, 6: {name: "as_int", wire: 1},
		8: {name: "flags", wire: 0}},
	mHistPoint: {9: {name: "attributes", wire: 2, msg: mKeyValue, isMsg: true, attrs: levelPoint},
		2: {name: "start_time_unix_nano", wire: 1}, 3: {name: "time_unix_nano", wire: 1}, 4: {name: "count", wire: 1},
		5: {name: "sum", wire: 1}, 6: {name: "bucket_counts", wire: 2}, 7: {name: "explicit_bounds", wire: 2},
		10: {name: "flags", wire: 0}, 11: {name: "min", wire: 1}, 12: {name: "max", wire: 1}},
	mExpPoint: {1: {name: "attributes", wire: 2, msg: mKeyValue, isMsg: true, attrs: levelPoint},
		2: {name: "start_time_unix_nano", wire: 1}, 3: {name: "time_unix_nano", wire: 1}, 4: {name: "count", wire: 1},
		5: {name: "sum", wire: 1}, 6: {name: "scale", wire: 0}, 7: {name: "zero_count", wire: 1},
		8: {name: "positive", wire: 2, msg: mExpBuckets, isMsg: true}, 9: {name: "negative", wire: 2, msg: mExpBuckets, isMsg: true},
		10: {name: "flags", wire: 0}, 12: {name: "min", wire: 1}, 13: {name: "max", wire: 1}, 14: {name: "zero_threshold", wire: 1}},
	mExpBuckets: {1: {name: "offset", wire: 0}, 2: {name: "bucket_counts", wire: 2}},
	// Span: ids, parent, flags, kind, times, sampling tracestate, attributes, an empty status — no name, events,
	// links, dropped counts or status message.
	mSpan: {1: {name: "trace_id", wire: 2}, 2: {name: "span_id", wire: 2}, 3: {name: "trace_state", wire: 2},
		4: {name: "parent_span_id", wire: 2}, 16: {name: "flags", wire: 5}, 6: {name: "kind", wire: 0},
		7: {name: "start_time_unix_nano", wire: 1}, 8: {name: "end_time_unix_nano", wire: 1},
		9:  {name: "attributes", wire: 2, msg: mKeyValue, isMsg: true, attrs: levelSpan},
		15: {name: "status", wire: 2, msg: mStatus, isMsg: true}},
	mStatus:   {}, // must be empty: no message, code unset
	mKeyValue: {1: {name: "key", wire: 2}, 2: {name: "value", wire: 2, msg: mAnyValue, isMsg: true}},
	// Values: string, bool, int — never arrays, maps, bytes or doubles.
	mAnyValue: {1: {name: "string_value", wire: 2}, 2: {name: "bool_value", wire: 0}, 3: {name: "int_value", wire: 0}},
}

var allowedKeys = map[attrLevel]map[string]bool{
	levelResource: {keyServiceName: true, keyServiceInstance: true, keyServiceNamespace: true, keyDeployEnvName: true,
		AttrTenantID: true, AttrReceivedAt: true, AttrStreamInstance: true, AttrTenantLevel: true},
	// Point and counter keys include the Stellar client metrics' closed keys (step 4a); which key may appear on which
	// metric is checked per metric by checkStellarInvariants.
	levelPoint: {AttrRoute: true, AttrRulesVersion: true, keyMethod: true, keyStatus: true,
		keyRPCMethod: true, keyRPCSystem: true, keyRPCSystemName: true, keyMetricOverflow: true,
		keyErrorType: true, keyRPCStatusCode: true, keyURLTemplate: true, keyStellarNetwork: true,
		keyPartner: true, keyPartnerOperation: true, keyPartnerOutcome: true, // step 4b (checkRuleInvariants per metric)
		keySep: true, keyAnchorStep: true, keyAnchorOutcome: true, keyAnchorHomeDomain: true, keyAnchorKind: true, // 4d
		keyAnchorStatus: true},
	levelCounter: {AttrReason: true, keyServiceName: true,
		keyStellarVia: true, keyStellarStatus: true, keyStellarResult: true, keySimOutcome: true, keySimErrorClass: true,
		keyStellarNetwork: true,
		// step 4c (checkRuleInvariants per metric)
		keyPayProtocol: true, keyPayStage: true, keyPayScheme: true, keyPayMethod: true, keyPayIntent: true,
		keyPayNetwork: true, keyPayAsset: true, keyPayAmountBucket: true, keyPayReasonClass: true, keyErrorType: true,
		// step 4d
		keySep: true, keyAnchorEvent: true, keyAnchorHomeDomain: true, keyAnchorKind: true, keyAnchorStatus: true,
		keyAnchorStatusFrom: true, keyAnchorClient: true},
	levelSpan: {AttrRoute: true, AttrRulesVersion: true, keyMethod: true, keyStatus: true,
		keyRPCMethod: true, keyRPCSystem: true, keyRPCSystemName: true,
		AttrMarker: true, AttrReason: true, keyServiceName: true, AttrDroppedCount: true},
}

// protoViolations walks b as message kind k and returns every field or key
// outside the allow-list, by path. strs receives every string on the wire.
func protoViolations(b []byte, k msgKind, path string, level attrLevel, strs func(path, s string)) []string {
	var out []string
	key := ""
	for len(b) > 0 {
		tag, n := binary.Uvarint(b)
		if n <= 0 {
			return append(out, path+": bad tag")
		}
		b = b[n:]
		num, wire := int(tag>>3), int(tag&7)
		var payload []byte
		switch wire {
		case 0:
			_, n = binary.Uvarint(b)
			if n <= 0 {
				return append(out, path+": bad varint")
			}
			b = b[n:]
		case 1:
			if len(b) < 8 {
				return append(out, path+": short fixed64")
			}
			b = b[8:]
		case 5:
			if len(b) < 4 {
				return append(out, path+": short fixed32")
			}
			b = b[4:]
		case 2:
			l, n := binary.Uvarint(b)
			if n <= 0 || l > uint64(len(b)-n) {
				return append(out, path+": bad length")
			}
			payload = b[n : n+int(l)]
			b = b[n+int(l):]
		default:
			return append(out, fmt.Sprintf("%s: wire type %d", path, wire))
		}
		f, ok := allowedFields[k][num]
		if !ok {
			out = append(out, fmt.Sprintf("%s.<field %d>", path, num))
			continue
		}
		p := path + "." + f.name
		if f.wire != wire {
			out = append(out, fmt.Sprintf("%s: wire type %d, want %d", p, wire, f.wire))
			continue
		}
		switch {
		case f.isMsg:
			lv := level
			if f.attrs != levelNone {
				lv = f.attrs
			}
			out = append(out, protoViolations(payload, f.msg, p, lv, strs)...)
		case wire == 2 && k != mHistPoint && k != mExpBuckets && f.name != "trace_id" && f.name != "span_id" && f.name != "parent_span_id":
			strs(p, string(payload))
			if k == mKeyValue && num == 1 {
				key = string(payload)
				if !allowedKeys[level][key] {
					out = append(out, fmt.Sprintf("%s: key %q not allowed here", p, key))
				}
			}
		}
	}
	return out
}

func assertProtoAllowListMetrics(t testing.TB, md pmetric.Metrics, strs func(path, s string)) {
	t.Helper()
	b, err := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
	if err != nil {
		t.Fatal(err)
	}
	if v := protoViolations(b, mExportMetrics, "metrics", levelNone, strs); len(v) > 0 {
		t.Fatalf("fields outside the allow-list:\n%v", v)
	}
}

func assertProtoAllowListTraces(t testing.TB, td ptrace.Traces, strs func(path, s string)) {
	t.Helper()
	b, err := (&ptrace.ProtoMarshaler{}).MarshalTraces(td)
	if err != nil {
		t.Fatal(err)
	}
	if v := protoViolations(b, mExportTraces, "traces", levelNone, strs); len(v) > 0 {
		t.Fatalf("fields outside the allow-list:\n%v", v)
	}
}

// TestProtoWalkerCatchesExtras proves the walker fails on what C-114 forbids.
func TestProtoWalkerCatchesExtras(t *testing.T) {
	md := pmetric.NewMetrics()
	r := md.ResourceMetrics().AppendEmpty()
	r.SetSchemaUrl("https://example/schema")
	r.Resource().Attributes().PutStr("host.name", "x")
	sm := r.ScopeMetrics().AppendEmpty()
	sm.Scope().Attributes().PutStr("a", "b")
	m := sm.Metrics().AppendEmpty()
	m.SetDescription("d")
	m.SetEmptyGauge().DataPoints().AppendEmpty().SetDoubleValue(math.Pi)
	b, _ := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
	v := protoViolations(b, mExportMetrics, "metrics", levelNone, func(string, string) {})
	if len(v) < 5 {
		t.Fatalf("walker missed violations: %v", v)
	}
}
