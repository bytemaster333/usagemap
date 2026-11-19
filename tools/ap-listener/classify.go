// SPDX-License-Identifier: Apache-2.0
package main

import (
	"regexp"
	"strings"
	"sync"
)

// Closed sets of every attribute value the listener emits. Values come from
// Anchor Platform 5.0.0 (stellar/anchor-platform @ be20b62):
// AnchorEvent.Type, PlatformTransactionData.Sep/Kind, SepTransactionStatus and
// Sep12Status. Anything else becomes "_OTHER".
const (
	other   = "_OTHER"
	none    = "_none"
	fromNew = "_new"
	fromUnk = "_unknown"
)

var (
	eventTypes = newSet("transaction_created", "transaction_status_changed", "quote_created", "customer_updated")
	txSeps     = newSet("6", "24", "31")
	kinds      = newSet("deposit", "deposit-exchange", "withdrawal", "withdrawal-exchange", "receive")
	statuses   = newSet(
		"pending_anchor", "pending_trust", "pending_user", "pending_user_transfer_start",
		"pending_user_transfer_complete", "incomplete", "no_market", "too_small", "too_large",
		"pending_sender", "pending_receiver", "pending_transaction_info_update",
		"pending_customer_info_update", "completed", "refunded", "expired", "error",
		"pending_external", "pending_stellar", "on_hold",
	)
	terminal         = newSet("completed", "refunded", "expired", "error", "no_market", "too_small", "too_large")
	customerStatuses = newSet("NEEDS_INFO", "ACCEPTED", "PROCESSING", "REJECTED")
	networks         = newSet("mainnet", "testnet", "futurenet", "local", "unknown")
)

type set map[string]struct{}

func newSet(vs ...string) set {
	s := make(set, len(vs))
	for _, v := range vs {
		s[v] = struct{}{}
	}
	return s
}

func (s set) has(v string) bool { _, ok := s[v]; return ok }

// pick returns v when it is a member of s, else def.
func (s set) pick(v, def string) string {
	if s.has(v) {
		return v
	}
	return def
}

var (
	labelRe      = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	secretishRe  = regexp.MustCompile(`^(?:[a-z2-7]{52,}|[0-9a-f]{32,})$`)
	clientNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,62}$`)
	strkeyRe     = regexp.MustCompile(`(?i)[gcmsb][a-z2-7]{55}`)
	nonPublicTLD = newSet("localhost", "local", "internal", "test", "example", "invalid", "lan", "home", "corp", "onion", "arpa")
)

// publicDomain returns the lower-cased public DNS name, or "" when s is not
// one (IP literal, single label, reserved TLD, key-like label, port, path).
// The same rule as packages/anchor-otel homeDomainOf.
func publicDomain(s string) string {
	h := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(s)), ".")
	if h == "" || len(h) > 253 {
		return ""
	}
	labels := strings.Split(h, ".")
	if len(labels) < 2 {
		return ""
	}
	for _, l := range labels {
		if !labelRe.MatchString(l) || secretishRe.MatchString(l) {
			return ""
		}
	}
	tld := labels[len(labels)-1]
	if strings.Trim(tld, "0123456789") == "" || nonPublicTLD.has(tld) {
		return ""
	}
	return h
}

// clients bounds the client attribute: the wallet's public client_domain,
// else Anchor Platform's configured client name, else "_none"; at most max
// distinct values per process, later ones "_OTHER".
type clients struct {
	mu   sync.Mutex
	seen map[string]struct{}
	max  int
}

func newClients(max int) *clients { return &clients{seen: map[string]struct{}{}, max: max} }

func (c *clients) of(domain, name string) string {
	v := publicDomain(domain)
	if v == "" {
		n := strings.ToLower(strings.TrimSpace(name))
		if n != "" && clientNameRe.MatchString(n) && !strkeyRe.MatchString(n) && !secretishRe.MatchString(n) {
			v = n
		}
	}
	if v == "" {
		if domain == "" && name == "" {
			return none
		}
		return other
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.seen[v]; ok {
		return v
	}
	if len(c.seen) >= c.max {
		return other
	}
	c.seen[v] = struct{}{}
	return v
}
