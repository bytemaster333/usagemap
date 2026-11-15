// SPDX-License-Identifier: Apache-2.0

package appevents

import "testing"

func TestAppVersionKeepsTheNumericCoreOnly(t *testing.T) {
	for in, want := range map[string]string{"1.4.2": "1.4.2", "2": "2", "1.0.0-beta.3+build.77": "1.0.0", "10.2.0+4211": "10.2.0"} {
		b, err := Parse([]byte(`{"v":1,"k":"AAAAAAAAAAAAAAAAAAAAAA","platform":"android","app_version":"` + in + `","sdk_version":"mobile-flutter/0.1.0","events":[{"ts":1,"session":"abcdefghijklmnop","name":"a"}]}`))
		if err != nil || b.AppVersion != want {
			t.Errorf("%s → %q %v", in, b.AppVersion, err)
		}
	}
}

func FuzzParse(f *testing.F) {
	f.Add([]byte(`{"v":1,"k":"AAAAAAAAAAAAAAAAAAAAAA","platform":"ios","app_version":"1.0","sdk_version":"mobile-rn/0.1.0","events":[{"ts":1,"session":"abcdefghijklmnop","name":"a","props":{"k":"v"}}]}`))
	f.Fuzz(func(t *testing.T, b []byte) {
		batch, err := Parse(b)
		if err != nil {
			return
		}
		if len(batch.Events) < 1 || len(batch.Events) > MaxEvents || !platforms[batch.Platform] {
			t.Fatalf("invalid batch admitted: %+v", batch)
		}
		for _, e := range batch.Events {
			if len(e.Props) > MaxProps || len(e.Name) > MaxNameLen {
				t.Fatalf("invalid event admitted: %+v", e)
			}
			_ = judgeEvent(e)
		}
	})
}
