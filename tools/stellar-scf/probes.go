// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Probe is the outcome of one check against the deployment.
type Probe struct {
	Name   string `json:"name"`
	State  string `json:"state"` // ok | warn | fail | skip
	HTTP   int    `json:"http,omitempty"`
	Detail string `json:"detail"`
	// Data carries a few public numbers (first-event probe only).
	Data map[string]any `json:"data,omitempty"`
}

const (
	stateOK   = "ok"
	stateWarn = "warn"
	stateFail = "fail"
	stateSkip = "skip"
)

func errorCode(b []byte) string {
	var e struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal(b, &e)
	if e.Error != "" {
		return e.Error
	}
	return e.Code
}

// probeHealth reads the platform health endpoint (wire-formats §i.2).
func probeHealth(ctx context.Context, portal string) Probe {
	p := Probe{Name: "platform"}
	res, err := doRequest(ctx, "GET", portal+"/public/v1/health", map[string]string{"Accept": "application/json"}, nil)
	if err != nil {
		p.State, p.Detail = stateFail, err.Error()
		return p
	}
	p.HTTP = res.Status
	var h struct {
		Status     string            `json:"status"`
		Components map[string]string `json:"components"`
		StatusPage string            `json:"status_page"`
	}
	if json.Unmarshal(res.Body, &h) != nil || h.Status == "" {
		p.State, p.Detail = stateFail, fmt.Sprintf("unexpected answer from %s/public/v1/health (HTTP %d)", portal, res.Status)
		return p
	}
	var bad []string
	for _, k := range slices.Sorted(maps.Keys(h.Components)) {
		if h.Components[k] != "ok" {
			bad = append(bad, k+"="+h.Components[k])
		}
	}
	switch h.Status {
	case "ok":
		p.State, p.Detail = stateOK, "all components ok"
	case "degraded":
		p.State, p.Detail = stateWarn, "degraded: "+strings.Join(bad, ", ")
	default:
		p.State, p.Detail = stateFail, "down: "+strings.Join(bad, ", ")
	}
	if h.StatusPage != "" {
		p.Detail += " (" + h.StatusPage + ")"
	}
	return p
}

// probeSite asks the edge for a challenge, exactly the portal's web test
// command (wire-formats §a.2): 200 = the site key is live at the edge.
// Domain checks have no oracle by design, so this proves the key only.
func probeSite(ctx context.Context, ingest, siteKey, profile, trackerVersion, origin string) Probe {
	p := Probe{Name: "site key at the edge"}
	body, _ := json.Marshal(map[string]any{"v": 1, "s": siteKey, "p": profile, "tv": trackerVersion})
	res, err := doRequest(ctx, "POST", ingest+"/v1/c", map[string]string{
		"Origin": origin, "Content-Type": "text/plain;charset=UTF-8",
	}, body)
	if err != nil {
		p.State, p.Detail = stateFail, err.Error()
		return p
	}
	p.HTTP = res.Status
	switch code := errorCode(res.Body); {
	case res.Status == 200:
		p.State, p.Detail = stateOK, "the edge knows this site key and issued a challenge. Page views come from the tracker (it adds a proof of work); open a page with the snippet and watch the portal's first-event panel"
		if d := res.Header.Get("X-Scf-Debug"); d != "" {
			p.Detail += "; debug: " + d
		}
	case res.Status == 404:
		p.State, p.Detail = stateFail, "unknown_site: the edge does not know this site key. A new website reaches the edge within about a minute; an archived or removed site never does"
	case res.Status == 410:
		p.State, p.Detail = stateFail, "tracker "+trackerVersion+" is withdrawn: update the pinned script (stellar scf init prints the current tag)"
	case res.Status == 429:
		p.State, p.Detail = stateWarn, code+": rate limit or quota, retry after "+res.Header.Get("Retry-After")+" s"
	default:
		p.State, p.Detail = stateFail, fmt.Sprintf("unexpected HTTP %d %s", res.Status, code)
	}
	return p
}

// otlpStatus maps the OTLP ingest answer (wire-formats §f.3) to a probe.
func otlpStatus(p Probe, res *response, okDetail string) Probe {
	p.HTTP = res.Status
	switch {
	case res.Status == 200:
		p.State, p.Detail = stateOK, okDetail
	case res.Status == 401:
		p.State, p.Detail = stateFail, "401: the ingest token is unknown, revoked or expired, or the project was removed"
	case res.Status == 403:
		p.State, p.Detail = stateFail, "403: the project is pending approval or suspended"
	case res.Status == 400:
		p.State, p.Detail = stateFail, "400: the request was refused as malformed"
	case res.Status == 429 || res.Status == 503:
		p.State, p.Detail = stateWarn, fmt.Sprintf("%d: busy or rate limited, retry after %s s", res.Status, res.Header.Get("Retry-After"))
	default:
		p.State, p.Detail = stateFail, fmt.Sprintf("unexpected HTTP %d", res.Status)
	}
	return p
}

// probeToken sends an empty OTLP export: it authenticates the token and the
// project status without storing anything.
func probeToken(ctx context.Context, otlp, token string) Probe {
	p := Probe{Name: "ingest token"}
	if err := checkKey(token, "ing"); err != nil {
		p.State, p.Detail = stateFail, err.Error()
		return p
	}
	res, err := doRequest(ctx, "POST", otlp+"/v1/metrics", map[string]string{
		"Authorization": "Bearer " + token, "Content-Type": "application/json",
	}, []byte(`{"resourceMetrics":[]}`))
	if err != nil {
		p.State, p.Detail = stateFail, err.Error()
		return p
	}
	return otlpStatus(p, res, "accepted: the token is valid and the project is active (an empty export, nothing stored)")
}

// probeFirstEvent reads the public per-project metrics document (§i.1).
func probeFirstEvent(ctx context.Context, portal, slug, shareKey string) Probe {
	p := Probe{Name: "counted data"}
	hdr := map[string]string{"Accept": "application/json"}
	if shareKey != "" {
		if err := checkKey(shareKey, "pub"); err != nil {
			p.State, p.Detail = stateFail, "share key: "+err.Error()
			return p
		}
		hdr["Authorization"] = "Bearer " + shareKey
	}
	res, err := doRequest(ctx, "GET", portal+"/public/v1/projects/"+url.PathEscape(slug)+"/metrics.json", hdr, nil)
	if err != nil {
		p.State, p.Detail = stateFail, err.Error()
		return p
	}
	p.HTTP = res.Status
	if res.Status == 404 {
		p.State = stateFail
		p.Detail = "404: no such active project, or its stats are not public and no valid share key was given (" + envShareKey + "); the answer is the same on purpose"
		return p
	}
	if res.Status != 200 {
		p.State, p.Detail = stateFail, fmt.Sprintf("unexpected HTTP %d", res.Status)
		return p
	}
	var d struct {
		GeneratedAt string `json:"generated_at"`
		Window      struct {
			Start, End string
			Days       int
		} `json:"window"`
		Web struct {
			Verified struct {
				Pageviews int64 `json:"pageviews"`
			} `json:"verified"`
			Raw struct {
				Pageviews int64 `json:"pageviews"`
			} `json:"raw"`
		} `json:"web"`
		API struct {
			Requests int64 `json:"requests"`
		} `json:"api"`
	}
	if err := json.Unmarshal(res.Body, &d); err != nil {
		p.State, p.Detail = stateFail, "the metrics document is not valid JSON"
		return p
	}
	p.Data = map[string]any{
		"window_days": d.Window.Days, "generated_at": d.GeneratedAt,
		"web_pageviews_verified": d.Web.Verified.Pageviews, "web_pageviews_raw": d.Web.Raw.Pageviews,
		"api_requests": d.API.Requests,
	}
	summary := fmt.Sprintf("last %d complete UTC days: %d verified page views (%d raw), %d API requests; built %s",
		d.Window.Days, d.Web.Verified.Pageviews, d.Web.Raw.Pageviews, d.API.Requests, d.GeneratedAt)
	if d.Web.Raw.Pageviews == 0 && d.API.Requests == 0 {
		p.State = stateWarn
		p.Detail = "no counted data yet. " + summary + ". This document counts complete UTC days only and is rebuilt hourly, so today's first event appears tomorrow; the portal's first-event panel shows it live"
		return p
	}
	p.State, p.Detail = stateOK, summary
	return p
}

// testStartOffset is how long before the point the test stream "started":
// more than the metrics writer's 10-minute fresh window (C-122).
const testStartOffset = 3600

// testMetric is the portal's test data point (control-plane
// src/integrations/test-commands.ts otlpTestCurl), byte for byte: one
// cumulative GET 200 request on route /usagemap-test, scope "usagemap-test",
// from a fresh service.instance.id whose stream started an hour earlier. The
// writer records such a first point of an unseen stream only as
// cumulative_first_point and adds nothing to any metric, so the test is
// never counted as traffic. pid plays the shell's $$ in the instance id.
func testMetric(service string, now time.Time, pid int) []byte {
	end := strconv.FormatInt(now.Unix(), 10) + "000000000"
	start := strconv.FormatInt(now.Unix()-testStartOffset, 10) + "000000000"
	var q bytes.Buffer
	enc := json.NewEncoder(&q)
	enc.SetEscapeHTML(false) // as JSON.stringify
	_ = enc.Encode(service)
	return []byte(`{"resourceMetrics":[{"resource":{"attributes":[` +
		`{"key":"service.name","value":{"stringValue":` + strings.TrimSuffix(q.String(), "\n") + `}},` +
		`{"key":"service.instance.id","value":{"stringValue":"usagemap-test-` + end + `-` + strconv.Itoa(pid) + `"}}]},` +
		`"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s",` +
		`"histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[` +
		`{"key":"http.request.method","value":{"stringValue":"GET"}},` +
		`{"key":"http.route","value":{"stringValue":"/usagemap-test"}},` +
		`{"key":"http.response.status_code","value":{"intValue":"200"}}],` +
		`"startTimeUnixNano":"` + start + `","timeUnixNano":"` + end + `",` +
		`"count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}`)
}

// sendTestMetric first runs the payload through the real sanitise step (so a
// service name the processor would refuse fails here, offline), then sends it.
func sendTestMetric(ctx context.Context, otlp, token, service string, now time.Time) Probe {
	p := Probe{Name: "test metric"}
	body := testMetric(service, now, os.Getpid())
	rep, err := Check(body, Options{Services: service, ReceivedAt: strconv.FormatInt(now.UnixNano(), 10)})
	if err != nil || rep.KeptItems != 1 {
		p.State, p.Detail = stateFail, "the test data point would not be kept by the sanitise step (check the service name)"
		return p
	}
	if err := checkKey(token, "ing"); err != nil {
		p.State, p.Detail = stateFail, err.Error()
		return p
	}
	res, err := doRequest(ctx, "POST", otlp+"/v1/metrics", map[string]string{
		"Authorization": "Bearer " + token, "Content-Type": "application/json",
	}, body)
	if err != nil {
		p.State, p.Detail = stateFail, err.Error()
		return p
	}
	return otlpStatus(p, res, `accepted: one test point on route /usagemap-test for service "`+service+`". It is never counted as traffic: the portal's first-event panel shows its arrival (cumulative_first_point) within about two minutes, if the service is registered (data of unregistered services is not stored)`)
}
