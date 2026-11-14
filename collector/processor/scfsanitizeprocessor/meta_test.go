// SPDX-License-Identifier: Apache-2.0
package scfsanitizeprocessor

import (
	"testing"
	"time"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
)

func TestParseMeta(t *testing.T) {
	now := time.Unix(0, testRecv+5*second)
	tests := []struct {
		name         string
		md           map[string][]string
		ok           bool
		tenant       string
		allowAll     bool
		allowed      []string
		notAllowed   []string
		receivedAt   int64
		recvFallback bool
		level        int64
		hasLevel     bool
		levelAbsent  string // "" → defaults to "missing" when !hasLevel and ok
	}{
		{
			name: "complete",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-allowed-services": {"*"}, "x-scf-received-at": {"1794499200000000000"}, "x-scf-tenant-level": {"L2"}},
			ok:   true, tenant: testTenant, allowAll: true, receivedAt: testRecv, level: 2, hasLevel: true,
		},
		{
			name: "level L0",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-received-at": {"1794499200000000000"}, "X-Scf-Tenant-Level": {"L0"}},
			ok:   true, tenant: testTenant, receivedAt: testRecv, level: 0, hasLevel: true,
		},
		{
			name: "level L3",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-received-at": {"1794499200000000000"}, "x-scf-tenant-level": {"L3"}},
			ok:   true, tenant: testTenant, receivedAt: testRecv, level: 3, hasLevel: true,
		},
		{
			name: "header names are case-insensitive, tenant upper-case is canonicalised",
			md:   map[string][]string{"X-Scf-Tenant-Id": {"11111111-2222-4333-8444-55555555555A"}, "X-SCF-ALLOWED-SERVICES": {"checkout"}, "X-Scf-Received-At": {"1794499200000000000"}},
			ok:   true, tenant: "11111111-2222-4333-8444-55555555555a", allowed: []string{"checkout"}, notAllowed: []string{"other"}, receivedAt: testRecv,
		},
		{
			name: "percent-encoded comma list",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-allowed-services": {"a%2Cb, my%20svc ,,%E2%82%AC"}},
			ok:   true, tenant: testTenant, allowed: []string{"a,b", "my svc", "€"}, notAllowed: []string{"a", "b", "*"},
			receivedAt: now.UnixNano(), recvFallback: true,
		},
		{
			name: "allowed header missing allows nothing",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-received-at": {"1794499200000000000"}},
			ok:   true, tenant: testTenant, notAllowed: []string{"checkout", "*", ""}, receivedAt: testRecv,
		},
		{
			name: "allowed header repeated allows nothing",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-allowed-services": {"*", "*"}},
			ok:   true, tenant: testTenant, notAllowed: []string{"checkout"}, receivedAt: now.UnixNano(), recvFallback: true,
		},
		{
			name: "level out of range is absent",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-received-at": {"1794499200000000000"}, "x-scf-tenant-level": {"L4"}},
			ok:   true, tenant: testTenant, receivedAt: testRecv, levelAbsent: levelInvalid,
		},
		{
			name: "level lower-case is absent",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-received-at": {"1794499200000000000"}, "x-scf-tenant-level": {"l1"}},
			ok:   true, tenant: testTenant, receivedAt: testRecv, levelAbsent: levelInvalid,
		},
		{
			name: "level as a bare number is absent",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-received-at": {"1794499200000000000"}, "x-scf-tenant-level": {"1"}},
			ok:   true, tenant: testTenant, receivedAt: testRecv, levelAbsent: levelInvalid,
		},
		{
			name: "level with padding is absent",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-received-at": {"1794499200000000000"}, "x-scf-tenant-level": {" L1"}},
			ok:   true, tenant: testTenant, receivedAt: testRecv, levelAbsent: levelInvalid,
		},
		{
			name: "level empty is absent",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-received-at": {"1794499200000000000"}, "x-scf-tenant-level": {""}},
			ok:   true, tenant: testTenant, receivedAt: testRecv, levelAbsent: levelInvalid,
		},
		{
			name: "level repeated is absent",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-received-at": {"1794499200000000000"}, "x-scf-tenant-level": {"L1", "L1"}},
			ok:   true, tenant: testTenant, receivedAt: testRecv, levelAbsent: levelInvalid,
		},
		{name: "tenant missing", md: map[string][]string{"x-scf-allowed-services": {"*"}}},
		{name: "tenant empty", md: map[string][]string{"x-scf-tenant-id": {""}}},
		{name: "tenant repeated", md: map[string][]string{"x-scf-tenant-id": {testTenant, testTenant}}},
		{name: "tenant not a uuid", md: map[string][]string{"x-scf-tenant-id": {"FORGED-TENANT"}}},
		{name: "tenant uuid with braces", md: map[string][]string{"x-scf-tenant-id": {"{" + testTenant + "}"}}},
		{name: "tenant uuid bad hex", md: map[string][]string{"x-scf-tenant-id": {"11111111-2222-4333-8444-55555555555g"}}},
		{name: "tenant uuid misplaced dash", md: map[string][]string{"x-scf-tenant-id": {"111111112-222-4333-8444-555555555555"}}},
		{
			name: "received-at not a number falls back to the clock",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-allowed-services": {"*"}, "x-scf-received-at": {"yesterday"}},
			ok:   true, tenant: testTenant, allowAll: true, receivedAt: now.UnixNano(), recvFallback: true,
		},
		{
			name: "received-at negative falls back to the clock",
			md:   map[string][]string{"x-scf-tenant-id": {testTenant}, "x-scf-allowed-services": {"*"}, "x-scf-received-at": {"-5"}},
			ok:   true, tenant: testTenant, allowAll: true, receivedAt: now.UnixNano(), recvFallback: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rm, ok := parseMeta(client.NewMetadata(tc.md), now)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if !ok {
				return
			}
			if rm.tenant != tc.tenant {
				t.Errorf("tenant = %q, want %q", rm.tenant, tc.tenant)
			}
			if rm.allowAll != tc.allowAll {
				t.Errorf("allowAll = %v", rm.allowAll)
			}
			for _, s := range tc.allowed {
				if !rm.serviceAllowed(s) {
					t.Errorf("%q not allowed", s)
				}
			}
			for _, s := range tc.notAllowed {
				if rm.serviceAllowed(s) {
					t.Errorf("%q allowed", s)
				}
			}
			if rm.receivedAt != tc.receivedAt || rm.receivedAtFallback != tc.recvFallback {
				t.Errorf("receivedAt = %d (fallback %v), want %d (%v)", rm.receivedAt, rm.receivedAtFallback, tc.receivedAt, tc.recvFallback)
			}
			wantAbsent := tc.levelAbsent
			if !tc.hasLevel && wantAbsent == "" {
				wantAbsent = levelMissing
			}
			if rm.hasLevel != tc.hasLevel || rm.level != tc.level || rm.levelAbsent != wantAbsent {
				t.Errorf("level = %d (has %v, absent %q), want %d (%v, %q)", rm.level, rm.hasLevel, rm.levelAbsent, tc.level, tc.hasLevel, wantAbsent)
			}
		})
	}
}

// The level reaches the output resource as an int and requests without a
// valid level are counted by reason (C-116).
func TestTenantLevelStampedAndCounted(t *testing.T) {
	h := newHarness(t)
	md := pmetric.NewMetrics()
	r := md.ResourceMetrics().AppendEmpty()
	r.Resource().Attributes().PutStr("service.name", "checkout")
	r.Resource().Attributes().PutInt(AttrTenantLevel, 3) // forged by the tenant
	m := r.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	m.SetName(MetricServerDuration)
	m.SetUnit("s")
	hist := m.SetEmptyHistogram()
	hist.SetAggregationTemporality(pmetric.AggregationTemporalityCumulative)
	dp := hist.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(pcommon.Timestamp(testRecv - minute))
	dp.SetTimestamp(pcommon.Timestamp(testRecv - second))
	dp.ExplicitBounds().FromRaw([]float64{0.1, 1})
	dp.BucketCounts().FromRaw([]uint64{1, 0, 0})
	dp.SetCount(1)
	dp.Attributes().PutStr("http.route", "/a")

	levelOf := func(out pmetric.Metrics) (int64, bool) {
		t.Helper()
		if out.ResourceMetrics().Len() == 0 {
			t.Fatal("no output")
		}
		v, ok := out.ResourceMetrics().At(0).Resource().Attributes().Get(AttrTenantLevel)
		if ok && v.Type() != pcommon.ValueTypeInt {
			t.Fatalf("scf.tenant.level type %s", v.Type())
		}
		return v.Int(), ok
	}

	m1 := defaultMeta()
	m1.level = "L1"
	if lv, ok := levelOf(h.runMetrics(m1, md)); !ok || lv != 1 {
		t.Errorf("level = %d (present %v), want 1", lv, ok)
	}
	if _, ok := levelOf(h.runMetrics(defaultMeta(), md)); ok {
		t.Error("forged level kept when the header is missing")
	}
	m2 := defaultMeta()
	m2.level = "L9"
	if _, ok := levelOf(h.runMetrics(m2, md)); ok {
		t.Error("invalid level stamped")
	}
	if n := h.selfCounter(MetricTenantLevelAbsent, map[string]string{"reason": levelMissing}); n != 1 {
		t.Errorf("missing counted %d, want 1", n)
	}
	if n := h.selfCounter(MetricTenantLevelAbsent, map[string]string{"reason": levelInvalid}); n != 1 {
		t.Errorf("invalid counted %d, want 1", n)
	}
}
