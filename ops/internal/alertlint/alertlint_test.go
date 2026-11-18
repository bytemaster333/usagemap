// SPDX-License-Identifier: Apache-2.0

// Package alertlint checks the alerting baseline against the monitoring plan (ADR-0022 "every alert carries a
// runbook_url, enforced by a CI lint"; monitoring plan §6.1 "every alert has at least one firing and one non-firing
// case"):
//
//   - every alert of docs/monitoring-plan.md §4.4 is listed in ops/alerts/coverage.json;
//   - every alert with status rule/partial has a rule, and every rule's alert is in the plan or coverage;
//   - every rule carries severity and monitor_id labels and a runbook_url that names an existing ops/runbooks file;
//   - every alert rule has at least one firing and one non-firing promtool test case;
//   - every metric_missing/partial entry names the missing metric and an owner.
package alertlint

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

const root = "../../.."

// pendingRunbooks are runbooks the runbook owner has announced but not written yet; listed so the gap is
// visible in the test log instead of silently tolerated. Remove an entry when its file lands.
var pendingRunbooks = map[string]string{}

type entry struct {
	Status  string `json:"status"`
	Owner   string `json:"owner"`
	Missing string `json:"missing"`
	Where   string `json:"where"`
}

func planAlerts(t *testing.T) []string {
	t.Helper()
	f, err := os.Open(filepath.Join(root, "docs/monitoring-plan.md"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []string
	in := false
	name := regexp.MustCompile(`^\| ([A-Z][A-Za-z]+)( / ([A-Z][a-z]+))? \|`)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		l := sc.Text()
		if strings.HasPrefix(l, "### 4.4 ") {
			in = true
		} else if strings.HasPrefix(l, "### 4.5") {
			in = false
		}
		if !in {
			continue
		}
		m := name.FindStringSubmatch(l)
		if m == nil || m[1] == "Alert" {
			continue
		}
		out = append(out, m[1])
		if m[3] != "" { // "DashboardBurnRateFast / Slow"
			out = append(out, strings.TrimSuffix(m[1], "Fast")+m[3])
		}
	}
	if len(out) < 90 {
		t.Fatalf("parsed only %d alerts from the plan", len(out))
	}
	return out
}

type rule struct {
	alert, file           string
	severity, monitor, rb bool
	runbook               string
}

func rules(t *testing.T) []rule {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join(root, "ops/alerts/*.rules.yaml"))
	var out []rule
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var cur *rule
		for _, l := range strings.Split(string(b), "\n") {
			s := strings.TrimSpace(l)
			if strings.HasPrefix(s, "- alert: ") {
				out = append(out, rule{alert: strings.TrimPrefix(s, "- alert: "), file: filepath.Base(f)})
				cur = &out[len(out)-1]
				continue
			}
			if strings.HasPrefix(s, "- record: ") {
				cur = nil
			}
			if cur == nil {
				continue
			}
			if strings.HasPrefix(s, "labels:") {
				cur.severity = strings.Contains(s, "severity: ")
				cur.monitor = strings.Contains(s, "monitor_id: ")
			}
			if strings.HasPrefix(s, "runbook_url: ") {
				cur.rb = true
				cur.runbook = strings.TrimPrefix(s, "runbook_url: ")
			}
		}
	}
	return out
}

func testCases(t *testing.T) (firing, silent map[string]bool) {
	t.Helper()
	firing, silent = map[string]bool{}, map[string]bool{}
	files, _ := filepath.Glob(filepath.Join(root, "ops/alerts/tests/*.test.yaml"))
	inline := regexp.MustCompile(`alertname: (\w+), exp_alerts: \[\]`)
	for _, f := range files {
		b, _ := os.ReadFile(f)
		lines := strings.Split(string(b), "\n")
		for i, l := range lines {
			if m := inline.FindStringSubmatch(l); m != nil {
				silent[m[1]] = true
				continue
			}
			s := strings.TrimSpace(l)
			if strings.HasPrefix(s, "alertname: ") && i+2 < len(lines) &&
				strings.TrimSpace(lines[i+1]) == "exp_alerts:" && strings.Contains(lines[i+2], "- exp_labels:") {
				firing[strings.TrimPrefix(s, "alertname: ")] = true
			}
		}
	}
	return firing, silent
}

func TestCatalogueCoverage(t *testing.T) {
	var cov struct {
		Alerts map[string]entry `json:"alerts"`
	}
	b, err := os.ReadFile(filepath.Join(root, "ops/alerts/coverage.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &cov); err != nil {
		t.Fatal(err)
	}
	plan := planAlerts(t)
	inPlan := map[string]bool{}
	for _, a := range plan {
		inPlan[a] = true
		if _, ok := cov.Alerts[a]; !ok {
			t.Errorf("plan alert %s is not in coverage.json", a)
		}
	}
	ruleSet := map[string]bool{}
	for _, r := range rules(t) {
		ruleSet[r.alert] = true
	}
	counts := map[string]int{}
	for name, e := range cov.Alerts {
		counts[e.Status]++
		if !inPlan[name] {
			t.Errorf("coverage.json lists %s, which is not in the plan", name)
		}
		switch e.Status {
		case "rule":
			if !ruleSet[name] {
				t.Errorf("%s: status rule but no rule", name)
			}
		case "partial":
			if !ruleSet[name] || e.Missing == "" || e.Owner == "" {
				t.Errorf("%s: partial needs a rule, the missing metric and an owner", name)
			}
		case "metric_missing":
			if ruleSet[name] || e.Missing == "" || e.Owner == "" {
				t.Errorf("%s: metric_missing needs the missing metric and an owner, and no rule", name)
			}
		case "outside":
			if e.Where == "" {
				t.Errorf("%s: outside needs 'where'", name)
			}
		default:
			t.Errorf("%s: unknown status %q", name, e.Status)
		}
	}
	for name := range ruleSet {
		if !inPlan[name] {
			t.Errorf("rule %s is not in the monitoring plan", name)
		}
	}
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		t.Logf("%-15s %d", k, counts[k])
	}
	t.Logf("plan alerts: %d", len(plan))
}

func TestEveryRuleHasLabelsRunbookAndTests(t *testing.T) {
	firing, silent := testCases(t)
	for _, r := range rules(t) {
		if !r.severity || !r.monitor {
			t.Errorf("%s (%s): severity and monitor_id labels required", r.alert, r.file)
		}
		if !r.rb || !strings.HasPrefix(r.runbook, "ops/runbooks/") {
			t.Errorf("%s (%s): runbook_url ops/runbooks/<name>.md required", r.alert, r.file)
		} else if _, err := os.Stat(filepath.Join(root, r.runbook)); err != nil {
			if why, ok := pendingRunbooks[r.runbook]; ok {
				t.Logf("%s: runbook %s pending — %s", r.alert, r.runbook, why)
			} else {
				t.Errorf("%s: runbook %s does not exist", r.alert, r.runbook)
			}
		} else if _, ok := pendingRunbooks[r.runbook]; ok {
			t.Errorf("%s exists now: remove it from pendingRunbooks", r.runbook)
		}
		if !firing[r.alert] {
			t.Errorf("%s: no firing test case", r.alert)
		}
		if !silent[r.alert] && r.alert != "Watchdog" { // the Watchdog always fires
			t.Errorf("%s: no non-firing test case", r.alert)
		}
	}
}
