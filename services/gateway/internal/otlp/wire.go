// SPDX-License-Identifier: Apache-2.0

package otlp

import (
	"encoding/base64"
	"encoding/binary"
	"math"
	"strconv"
)

// Minimal protobuf helpers: the gateway never decodes OTLP payloads (the Collector does); it checks that a
// protobuf body is well-formed at the wire level and encodes google.rpc.Status / RetryInfo for error answers.

// WellFormed walks the top level of b's protobuf wire format: every tag, varint and fixed-width value must be
// complete and every length-delimited field must fit in the remaining bytes. Nested messages are not walked (a
// truncated nested message is left to the Collector, which answers 400). Groups and field
// number 0 are malformed.
func WellFormed(b []byte) bool { return wellFormed(b, 0) }

func wellFormed(b []byte, depth int) bool {
	for len(b) > 0 {
		tag, n := binary.Uvarint(b)
		if n <= 0 || tag>>3 == 0 || tag>>3 > math.MaxInt32 {
			return false
		}
		b = b[n:]
		switch tag & 7 {
		case 0:
			_, n := binary.Uvarint(b)
			if n <= 0 {
				return false
			}
			b = b[n:]
		case 1:
			if len(b) < 8 {
				return false
			}
			b = b[8:]
		case 5:
			if len(b) < 4 {
				return false
			}
			b = b[4:]
		case 2:
			l, n := binary.Uvarint(b)
			if n <= 0 || l > uint64(len(b)-n) {
				return false
			}
			b = b[n+int(l):]
		default:
			return false
		}
	}
	return true
}

func appendTag(b []byte, field, wt int) []byte { return binary.AppendUvarint(b, uint64(field<<3|wt)) }

func appendBytes(b []byte, field int, v []byte) []byte {
	b = appendTag(b, field, 2)
	b = binary.AppendUvarint(b, uint64(len(v)))
	return append(b, v...)
}

// statusProto encodes google.rpc.Status{code, message, details}; retryAfter > 0 adds a google.rpc.RetryInfo.
func statusProto(code int, msg string, retryAfter int) []byte {
	var b []byte
	b = appendTag(b, 1, 0)
	b = binary.AppendUvarint(b, uint64(code))
	b = appendBytes(b, 2, []byte(msg))
	if retryAfter > 0 {
		var dur []byte
		dur = appendTag(dur, 1, 0)
		dur = binary.AppendUvarint(dur, uint64(retryAfter))
		ri := appendBytes(nil, 1, dur) // RetryInfo.retry_delay
		anyMsg := appendBytes(nil, 1, []byte("type.googleapis.com/google.rpc.RetryInfo"))
		anyMsg = appendBytes(anyMsg, 2, ri)
		b = appendBytes(b, 3, anyMsg)
	}
	return b
}

// statusDetailsBin is the grpc-status-details-bin header value.
func statusDetailsBin(code int, msg string, retryAfter int) string {
	return base64.RawStdEncoding.EncodeToString(statusProto(code, msg, retryAfter))
}

// statusJSON is google.rpc.Status in the OTLP JSON mapping.
func statusJSON(code int, msg string) []byte {
	return []byte(`{"code":` + strconv.Itoa(code) + `,"message":` + strconv.Quote(msg) + `}`)
}
