// SPDX-License-Identifier: Apache-2.0

package batch

import (
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/cumul"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/hist"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// Converted is a delta in a stored layout, ready for the additive upsert.
type Converted struct {
	Row      hist.Row
	Count    int64
	Sum      float64
	Min, Max *float64
	Reasons  []string // data-quality reasons to count once for this point (hist_layout_approx, exp_scale_coarse, negative_value)
}

// Convert maps a delta (from a delta point, or computed from cumulative points) into explicit15 or exp3 (§9).
// It returns hist.ErrCountOverflow when a bucket would not fit int4 (count_overflow) and hist.ErrMalformed for an
// unusable layout (malformed_point).
func Convert(s cumul.Snapshot, minV, maxV *float64) (Converted, error) {
	var (
		row hist.Row
		err error
	)
	sum := max(s.Sum, 0)
	unitSuspect := false
	switch {
	case s.Exponential:
		row, err = hist.FromExponential(hist.Exponential{Scale: s.Scale, Zero: s.Zero, Offset: s.Offset,
			Positive: s.Buckets, Negative: s.Negative})
	case hist.IsMsDefaultBounds(s.Bounds):
		// Millisecond default bounds under unit "s": corrected or estimated, always "coarse".
		unitSuspect = true
		row, err = hist.FromMsDefaultUnderSeconds(s.Buckets, s.Sum, minV, maxV)
		if err == nil && hist.MsLayoutIsMilliseconds(s.Buckets) {
			// The values were milliseconds labelled "s": the sum, min and max are corrected like the buckets.
			sum, minV, maxV = s.Sum/1000, milli(minV), milli(maxV)
		}
	default:
		row, err = hist.FromExplicitSum(s.Bounds, s.Buckets, minV, maxV, s.Sum)
	}
	if err != nil {
		return Converted{}, err
	}
	c := Converted{Row: row, Count: row.Total(), Sum: sum, Min: minV, Max: maxV}
	switch {
	case unitSuspect:
		c.Reasons = append(c.Reasons, rules.ReasonHistUnitSuspect)
	case row.Quality == hist.QualityApprox:
		c.Reasons = append(c.Reasons, rules.ReasonHistLayoutApprox)
	case row.Quality == hist.QualityCoarse:
		c.Reasons = append(c.Reasons, rules.ReasonExpScaleCoarse)
	}
	if s.Negative > 0 {
		c.Reasons = append(c.Reasons, rules.ReasonNegativeValue)
	}
	return c, nil
}

func milli(v *float64) *float64 {
	if v == nil {
		return nil
	}
	x := *v / 1000
	return &x
}

// ConvertExplicit15 is Convert for tables with the explicit15 layout only (C-153): an exponential delta is split
// log-uniformly into explicit15 at any scale (exp_scale_coarse, quality 2).
func ConvertExplicit15(s cumul.Snapshot, minV, maxV *float64) (Converted, error) {
	if !s.Exponential {
		return Convert(s, minV, maxV)
	}
	row, err := hist.FromExponentialExplicit15(hist.Exponential{Scale: s.Scale, Zero: s.Zero, Offset: s.Offset,
		Positive: s.Buckets, Negative: s.Negative})
	if err != nil {
		return Converted{}, err
	}
	c := Converted{Row: row, Count: row.Total(), Sum: max(s.Sum, 0), Min: minV, Max: maxV,
		Reasons: []string{rules.ReasonExpScaleCoarse}}
	if s.Negative > 0 {
		c.Reasons = append(c.Reasons, rules.ReasonNegativeValue)
	}
	return c, nil
}
