// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"context"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/processor/processorhelper"
	"go.uber.org/zap"
)

// Span flag bits (OTLP SpanFlags).
const (
	flagHasIsRemote = 0x100 // SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK
	flagIsRemote    = 0x200 // SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK
	// spanFlagsMask keeps the W3C sampled and random bits and the two
	// is_remote bits; every other bit is cleared (C-114).
	spanFlagsMask = 0x303
)

// MaxSpanDuration bounds end − start of a span (C-114): a longer span is
// malformed_point, so a forged start time cannot stretch the span-derived
// histogram of the whole request.
const MaxSpanDuration = 24 * time.Hour

func (s *sanitizer) processTraces(ctx context.Context, td ptrace.Traces) (ptrace.Traces, error) {
	rm, ok := s.meta(ctx)
	if !ok {
		s.noTenant(ctx, "traces", int64(td.SpanCount()))
		return td, processorhelper.ErrSkipProcessingData
	}
	out, t, red, ok := s.sanitizeTracesSafe(td, &rm)
	if !ok {
		s.log.Error("scfsanitize: request dropped after an internal error", zap.String("signal", "traces"))
		out, t, red = ptrace.NewTraces(), tally{}, redactionSum{}
		t.add(UnknownService, ReasonMalformedPoint, int64(td.SpanCount()))
	}
	appendDropMarkers(out, &rm, &t)
	s.record(ctx, "traces", &rm, &t, &red, 0)
	if out.ResourceSpans().Len() == 0 {
		return out, processorhelper.ErrSkipProcessingData
	}
	return out, nil
}

// sanitizeTracesSafe builds the sanitised copy of td from scratch (C-114);
// ok is false when the step panicked.
func (s *sanitizer) sanitizeTracesSafe(td ptrace.Traces, rm *requestMeta) (out ptrace.Traces, t tally, red redactionSum, ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	if testPanicHook != nil {
		testPanicHook()
	}
	out = ptrace.NewTraces()
	for _, rs := range td.ResourceSpans().All() {
		res := rm.sanitizeResource(rs.Resource())
		if res.reason != "" {
			t.add(res.service, res.reason, int64(resourceSpans(rs)))
			continue
		}
		red.freeText += res.redactions
		var ors ptrace.ResourceSpans
		created := false
		for _, ss := range rs.ScopeSpans().All() {
			sc := sanitizeScope(ss.Scope())
			red.freeText += sc.redactions
			var oss ptrace.ScopeSpans
			scopeCreated := false
			for _, sp := range ss.Spans().All() {
				if !s.keepSpan(sp, res.service, rm, &t) {
					continue
				}
				if !created {
					ors = out.ResourceSpans().AppendEmpty()
					rm.writeResource(ors.Resource().Attributes(), &res.clean)
					created = true
				}
				if !scopeCreated {
					oss = ors.ScopeSpans().AppendEmpty()
					oss.Scope().SetName(sc.name)
					oss.Scope().SetVersion(sc.version)
					scopeCreated = true
				}
				s.copySpan(sp, oss.Spans().AppendEmpty(), res.service, &t, &red)
			}
		}
	}
	return out, t, red, true
}

func resourceSpans(rs ptrace.ResourceSpans) int {
	n := 0
	for _, ss := range rs.ScopeSpans().All() {
		n += ss.Spans().Len()
	}
	return n
}

// isLocalChild reports whether the span has a parent that its SDK says is in
// the same process: parent present, "has is_remote" set, "is_remote" clear
// (§f.5 step 5, S-04). Spans from SDKs that do not set 0x100 are roots for us.
func isLocalChild(sp ptrace.Span) bool {
	f := sp.Flags()
	return !sp.ParentSpanID().IsEmpty() && f&flagHasIsRemote != 0 && f&flagIsRemote == 0
}

// keepSpan applies steps 5 and 7 and the duration bound; dropped spans are
// counted.
func (s *sanitizer) keepSpan(sp ptrace.Span, service string, rm *requestMeta, t *tally) bool {
	if sp.Kind() != ptrace.SpanKindServer {
		t.add(service, ReasonSpanNotServer, 1)
		return false
	}
	if isLocalChild(sp) {
		t.add(service, ReasonSpanNotLocalRoot, 1)
		return false
	}
	start, end := sp.StartTimestamp(), sp.EndTimestamp()
	if start == 0 || end < start || uint64(end-start) > uint64(MaxSpanDuration) {
		t.add(service, ReasonMalformedPoint, 1)
		return false
	}
	if r := s.timeReason(end, rm); r != "" {
		t.add(service, r, 1)
		return false
	}
	return true
}

// copySpan writes the allow-listed fields of src into dst (a new span): ids,
// parent, masked flags, kind, times, the (capped) sampling threshold and the
// sanitised attributes. Name, status, events, links and dropped counts are
// never copied — they can carry raw paths or error text.
func (s *sanitizer) copySpan(src, dst ptrace.Span, service string, t *tally, red *redactionSum) {
	dst.SetTraceID(src.TraceID())
	dst.SetSpanID(src.SpanID())
	dst.SetParentSpanID(src.ParentSpanID())
	dst.SetFlags(src.Flags() & spanFlagsMask)
	dst.SetKind(ptrace.SpanKindServer)
	dst.SetStartTimestamp(src.StartTimestamp())
	dst.SetEndTimestamp(src.EndTimestamp())
	if ts := sampledTraceState(src.TraceState().AsRaw()); ts != "" {
		dst.TraceState().FromRaw(ts)
	}
	res := sanitizePointAttrs(src.Attributes(), dst.Attributes(), modeSpan)
	red.freeText += res.redactions
	if res.path.Redactions.Total() > 0 {
		t.add(service, ReasonRouteRedacted, 1)
		if seedRedacted(res.path) {
			t.add(service, ReasonRouteSeedRedacted, 1)
		}
		red.add(res.path.Redactions)
	}
}

// appendDropMarkers carries the traces pipeline's drop counts to
// signal_to_metrics, which turns them into scf.ingest.dropped (collector.yaml,
// metric "scf.ingest.dropped" with condition scf.marker == "ingest.dropped").
// Tenants cannot forge a marker: every tenant span attribute outside the
// allow-list, scf.marker included, was removed above.
func appendDropMarkers(td ptrace.Traces, rm *requestMeta, t *tally) {
	if t.empty() {
		return
	}
	rs := td.ResourceSpans().AppendEmpty()
	rm.stamp(rs.Resource().Attributes())
	rs.Resource().Attributes().PutStr(AttrStreamInstance, NoInstance)
	ss := rs.ScopeSpans().AppendEmpty()
	ss.Scope().SetName(ScopeName)
	ss.Scope().SetVersion(ScopeVersion)
	ts := pcommon.Timestamp(rm.receivedAt)
	for _, e := range t.entries() {
		sp := ss.Spans().AppendEmpty()
		sp.SetKind(ptrace.SpanKindInternal)
		sp.SetStartTimestamp(ts)
		sp.SetEndTimestamp(ts)
		a := sp.Attributes()
		a.PutStr(AttrMarker, MarkerDropped)
		a.PutStr(AttrReason, e.reason)
		a.PutStr(keyServiceName, e.service)
		a.PutInt(AttrDroppedCount, e.count)
	}
}
