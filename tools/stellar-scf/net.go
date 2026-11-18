// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Default endpoints of the public deployment.
const (
	defaultPortal = "https://app.usagemap.dev"
	defaultIngest = "https://e1.usagemap.dev"
	defaultOTLP   = "https://e1.usagemap.dev"
)

const maxResponse = 1 << 20

// httpClient is replaced in tests.
var httpClient = &http.Client{
	Timeout: 15 * time.Second,
	// Never follow a redirect: a bearer must not travel to another origin.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// baseURL validates an endpoint flag: https, or http only for a loopback host
// (a local stack). No path, query or credentials.
func baseURL(name, raw string) (string, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("--%s must be an absolute URL such as https://host", name)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("--%s must be an origin (scheme://host[:port]) without path, query or credentials", name)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !isLoopback(u.Hostname()) {
			return "", fmt.Errorf("--%s: plain http is allowed only for localhost", name)
		}
	default:
		return "", fmt.Errorf("--%s must use https", name)
	}
	return u.Scheme + "://" + u.Host, nil
}

func isLoopback(h string) bool {
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

type response struct {
	Status int
	Header http.Header
	Body   []byte
}

func doRequest(ctx context.Context, method, u string, hdr map[string]string, body []byte) (*response, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "stellar-scf/"+version)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := httpClient.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			// url.Error repeats the URL; keep only the cause.
			return nil, fmt.Errorf("%s %s: %w", method, redactURL(u), ue.Err)
		}
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, maxResponse))
	if err != nil {
		return nil, fmt.Errorf("%s %s: reading the answer: %w", method, redactURL(u), err)
	}
	return &response{Status: res.StatusCode, Header: res.Header, Body: b}, nil
}

func redactURL(u string) string {
	if p, err := url.Parse(u); err == nil {
		p.RawQuery = ""
		return p.String()
	}
	return "(url)"
}
