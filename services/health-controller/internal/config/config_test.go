// SPDX-License-Identifier: Apache-2.0

package config

import (
	"strings"
	"testing"
	"time"
)

const good = `{"instance":"mon-c",
 "nodes":[{"id":"edge-a1","ipv4":"192.0.2.1","health_url":"http://edge-a1:9464/healthz","ingest_url":"https://edge-a1.test"}],
 "hostnames":[{"name":"in.domain-a.test","zone":"domain-a.test","ttl":60,"nodes":["edge-a1"]}],
 "providers":[{"name":"dns-a","kind":"http","endpoint":"http://dns-a:8053"}],
 "canary":{"site_key":"k","origin":"https://canary.test"}}`

func TestDefaultsFollowC92(t *testing.T) {
	c, err := Parse([]byte(good))
	if err != nil {
		t.Fatal(err)
	}
	if c.Interval.Duration != 30*time.Second || c.FailRounds != 3 || c.RecoverRounds != 5 {
		t.Fatalf("defaults: %v %d %d", c.Interval, c.FailRounds, c.RecoverRounds)
	}
}

func TestRejects(t *testing.T) {
	for name, mut := range map[string]func(string) string{
		"unknown field": func(s string) string { return strings.Replace(s, `"instance"`, `"x":1,"instance"`, 1) },
		"bad instance":  func(s string) string { return strings.Replace(s, `"mon-c"`, `"Mon_C"`, 1) },
		"bad ipv4":      func(s string) string { return strings.Replace(s, `192.0.2.1`, `2001:db8::1`, 1) },
		"unknown node":  func(s string) string { return strings.Replace(s, `"nodes":["edge-a1"]`, `"nodes":["edge-zz"]`, 1) },
		"bad kind":      func(s string) string { return strings.Replace(s, `"kind":"http"`, `"kind":"route53"`, 1) },
		"ttl":           func(s string) string { return strings.Replace(s, `"ttl":60`, `"ttl":0`, 1) },
		"interval": func(s string) string {
			return strings.Replace(s, `"instance":"mon-c",`, `"instance":"mon-c","interval":"1s","probe_timeout":"2s",`, 1)
		},
	} {
		if _, err := Parse([]byte(mut(good))); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestProviderKinds(t *testing.T) {
	az := `{"name":"azure-dns","kind":"azure","subscription_id":"00000000-0000-0000-0000-000000000001","resource_group":"rg-dns"}`
	cf := `{"name":"cloudflare","kind":"cloudflare","token_file":"/run/secrets/cf_token"}`
	ok := strings.Replace(good, `{"name":"dns-a","kind":"http","endpoint":"http://dns-a:8053"}`, az+","+cf, 1)
	c, err := Parse([]byte(ok))
	if err != nil {
		t.Fatal(err)
	}
	if c.Providers[0].SubscriptionID == "" || c.Providers[1].TokenFile == "" {
		t.Fatalf("fields not read: %+v", c.Providers)
	}
	for name, p := range map[string]string{
		"azure without subscription":    `{"name":"a","kind":"azure","resource_group":"rg"}`,
		"azure bad subscription":        `{"name":"a","kind":"azure","subscription_id":"x","resource_group":"rg"}`,
		"azure without resource group":  `{"name":"a","kind":"azure","subscription_id":"00000000-0000-0000-0000-000000000001"}`,
		"azure with a token file":       `{"name":"a","kind":"azure","subscription_id":"00000000-0000-0000-0000-000000000001","resource_group":"rg","token_file":"/t"}`,
		"azure bad endpoint":            `{"name":"a","kind":"azure","subscription_id":"00000000-0000-0000-0000-000000000001","resource_group":"rg","endpoint":"ftp://x"}`,
		"cloudflare without token file": `{"name":"c","kind":"cloudflare"}`,
		"cloudflare bad endpoint":       `{"name":"c","kind":"cloudflare","token_file":"/t","endpoint":"not a url"}`,
		"unknown provider field":        `{"name":"c","kind":"cloudflare","token_file":"/t","zone_id":"z"}`,
	} {
		bad := strings.Replace(good, `{"name":"dns-a","kind":"http","endpoint":"http://dns-a:8053"}`, p, 1)
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
