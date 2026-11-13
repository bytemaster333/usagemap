// SPDX-License-Identifier: Apache-2.0
// Package pathnorm is the SCF path normaliser: a hard-coded, versioned,
// deterministic and idempotent rule set (ADR-0012) that turns raw request
// paths, tenant http.route templates and web page paths into low-cardinality
// routes such as /accounts/{account}/payments.
//
// The same rule set and version run in the Collector's sanitise step (API
// spans and metrics) and in the web gateway (page paths, C-52), always in
// memory before anything is queued or spooled. Secrets (Stellar secret seeds,
// JWTs, API keys) and personal identifiers (e-mail, federation and phone
// numbers, IP literals) become {redacted} and are only counted by kind and
// location — never recorded, prefixed or hashed. StrKeys of all ten SEP-23
// v1.4.0 types are recognised by shape and strictly decoded by the package's
// own decoder; the checksum only chooses between the typed placeholder and
// {id}, and secret seeds are redacted on shape alone.
//
// The conformance suite is the 451-vector corpus in testdata/vectors.json,
// generated from the research corpus by internal/gen.
package pathnorm

//go:generate go run ./internal/gen -in ../../references/stellar-path-normalization-test-vectors-2026-11-12.md -out testdata/vectors.json
