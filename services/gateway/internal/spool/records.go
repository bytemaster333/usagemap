// SPDX-License-Identifier: Apache-2.0

package spool

import "encoding/json"

// EventRecord is the spool event record of wire-formats §d.2. Nothing in it identifies a person directly: no raw
// IP, no raw User-Agent, no query string, no event id, no token, no nonce, no client-signal values, no title.
type EventRecord struct {
	RV             int     `json:"rv"`
	Type           string  `json:"type"`
	RecordID       string  `json:"record_id"`
	NodeID         string  `json:"node_id"`
	Segment        uint64  `json:"segment"`
	Offset         int64   `json:"offset"`
	ReceivedAtMs   int64   `json:"received_at_ms"`
	TenantID       string  `json:"tenant_id"`
	SiteID         string  `json:"site_id"`
	Target         string  `json:"target"`           // main | twin
	UmamiWebsiteID *string `json:"umami_website_id"` // null only for twin while not provisioned
	Tag            string  `json:"tag"`              // v | s
	Surrogate      string  `json:"surrogate"`
	// EventKey is the event's de-duplication key (§d.2, C1 #11): hex SHA-256 of a domain tag, the site id and the
	// browser's per-event id — never the id itself. Absent in records written before it existed.
	EventKey     string         `json:"event_key,omitempty"`
	Country      string         `json:"country"`
	UA           string         `json:"ua"`
	Hostname     string         `json:"hostname"`
	URL          string         `json:"url"`
	ReferrerHost string         `json:"referrer_host,omitempty"`
	Screen       string         `json:"screen,omitempty"`
	Language     string         `json:"language,omitempty"`
	Kind         string         `json:"kind"` // pageview | custom | wallet
	Name         string         `json:"name,omitempty"`
	Data         map[string]any `json:"data,omitempty"`
}

// WebCounter is one row of a counter record's `web` array.
type WebCounter struct {
	TenantID string `json:"tenant_id"`
	SiteID   string `json:"site_id"`
	Day      string `json:"day"`
	Counter  string `json:"counter"`
	Label    string `json:"label"`
	Count    int64  `json:"count"`
}

// OTLPCounter is one row of a counter record's `otlp` array (filled by the OTLP front door).
type OTLPCounter struct {
	TenantID string `json:"tenant_id"`
	Day      string `json:"day"`
	Reason   string `json:"reason"`
	Count    int64  `json:"count"`
}

// TokenUse is one row of `tokens`.
type TokenUse struct {
	TokenID    string `json:"token_id"`
	TenantID   string `json:"tenant_id"`
	LastUsedMs int64  `json:"last_used_ms"`
}

// Accounting is the `spool` object of a counter record (§d.3, §d.4).
type Accounting struct {
	BootID              string `json:"boot_id"`
	Day                 string `json:"day"`
	Fsynced             int64  `json:"fsynced"`
	AckedStored         int64  `json:"acked_stored"`
	AckedEngineBot      int64  `json:"acked_engine_bot"`
	AckedEngineRejected int64  `json:"acked_engine_rejected"`
	Expired72h          int64  `json:"expired_72h"`
	Queued              int64  `json:"queued"`
	QueuedAtDayStart    *int64 `json:"queued_at_day_start,omitempty"`
}

// PropCounter is one row of a counter record's optional `props` array (C-136, §d.3): a Stellar event schema v1
// property count of accepted (verified/suspect) wallet events → web_event_property_daily.
type PropCounter struct {
	TenantID string `json:"tenant_id"`
	SiteID   string `json:"site_id"`
	Day      string `json:"day"`
	Event    string `json:"event"`
	Network  string `json:"network"`
	Key      string `json:"key"`
	Value    string `json:"value"`
	Verdict  string `json:"verdict"`
	Count    int64  `json:"count"`
}

// DevEvent is one entry of a counter record's optional `dev` array (C-136, §a.8, §d.3) → web_dev_events. It holds no
// visitor identifier, surrogate, address, User-Agent, referrer, country, property value or origin host.
type DevEvent struct {
	TenantID     string  `json:"tenant_id"`
	SiteID       string  `json:"site_id"`
	ReceivedAtMs int64   `json:"received_at_ms"`
	Kind         string  `json:"kind"` // pageview | custom | stellar
	Name         string  `json:"name"`
	Path         string  `json:"path"`
	WouldBe      string  `json:"would_be"` // verified | suspect | rejected
	Reason       *string `json:"reason"`
}

// AppCounter is one row of a counter record's optional `app` array (mobile/app intake, wire-formats §a.9, migration
// 0084) → app_event_daily. Self-attested counts only: no session id, device id, address, User-Agent or timestamp.
type AppCounter struct {
	TenantID string `json:"tenant_id"`
	SiteID   string `json:"site_id"`
	Day      string `json:"day"`
	Platform string `json:"platform"` // ios | android | web
	Event    string `json:"event"`    // tenant event name, or `_session`
	Key      string `json:"key"`
	Value    string `json:"value"`
	Count    int64  `json:"count"`
}

// CounterRecord is the spool counter record of §d.3.
type CounterRecord struct {
	RV            int           `json:"rv"`
	Type          string        `json:"type"`
	RecordID      string        `json:"record_id"`
	NodeID        string        `json:"node_id"`
	PeriodStartMs int64         `json:"period_start_ms"`
	PeriodEndMs   int64         `json:"period_end_ms"`
	Web           []WebCounter  `json:"web"`
	OTLP          []OTLPCounter `json:"otlp"`
	Tokens        []TokenUse    `json:"tokens"`
	Spool         Accounting    `json:"spool"`
	// Props and Dev are optional parts (C-136), present only when the edge snapshot advertises them and non-empty
	// (C-137 upgrade rule, §d.3); omitempty drops an empty part.
	Props []PropCounter `json:"props,omitempty"`
	Dev   []DevEvent    `json:"dev,omitempty"`
	// App is the optional `app` part (self-attested app events, §a.9), gated like props/dev by counter_features.
	App []AppCounter `json:"app,omitempty"`
	// RPC is the optional `rpc` part (browser Stellar RPC/Horizon aggregate, wire-formats §a.3.2), gated by
	// counter_features "rpc".
	RPC []RPCCounter `json:"rpc,omitempty"`
}

// Record is anything the spool can frame. The writer fills node_id, segment and offset of event records.
type Record interface {
	isEvent() bool
	site() string // event records: the site id (per-site spool share); "" otherwise
	receivedAtMs() int64
	marshal(node string, seg uint64, off int64) ([]byte, error)
}

func (e *EventRecord) isEvent() bool       { return true }
func (e *EventRecord) site() string        { return e.SiteID }
func (e *EventRecord) receivedAtMs() int64 { return e.ReceivedAtMs }
func (e *EventRecord) marshal(node string, seg uint64, off int64) ([]byte, error) {
	e.RV, e.Type, e.NodeID, e.Segment, e.Offset = 1, "event", node, seg, off
	return json.Marshal(e)
}

func (c *CounterRecord) isEvent() bool       { return false }
func (c *CounterRecord) site() string        { return "" }
func (c *CounterRecord) receivedAtMs() int64 { return c.PeriodEndMs }
func (c *CounterRecord) marshal(node string, _ uint64, _ int64) ([]byte, error) {
	c.RV, c.Type, c.NodeID = 1, "counter", node
	if c.Web == nil {
		c.Web = []WebCounter{}
	}
	if c.OTLP == nil {
		c.OTLP = []OTLPCounter{}
	}
	if c.Tokens == nil {
		c.Tokens = []TokenUse{}
	}
	return json.Marshal(c)
}

// header is what the spool needs from any record when it re-reads a segment.
type header struct {
	Type         string `json:"type"`
	ReceivedAtMs int64  `json:"received_at_ms"`
	PeriodEndMs  int64  `json:"period_end_ms"`
	SiteID       string `json:"site_id"`
}

// RPCCounter is one row of a counter record's optional `rpc` array (wire-formats §a.3.2, §d.3) →
// web_rpc_client_daily: per-site daily counts of browser-side Stellar RPC / Horizon calls by closed cell. No visitor
// identifier, session, page path, time of call, URL or address.
type RPCCounter struct {
	TenantID  string `json:"tenant_id"`
	SiteID    string `json:"site_id"`
	Day       string `json:"day"`
	API       string `json:"api"`       // rpc | horizon
	Operation string `json:"operation"` // closed list per api (§a.3.2)
	Network   string `json:"network"`
	Outcome   string `json:"outcome"`
	Latency   string `json:"latency"`
	Verdict   string `json:"verdict"` // verified | suspect
	Count     int64  `json:"count"`
}
