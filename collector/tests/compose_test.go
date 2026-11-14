// SPDX-License-Identifier: Apache-2.0
package collectortests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/collector/tests/internal/otlpsend"
	"github.com/bytemaster333/usagemap/collector/tests/internal/pki"
	"github.com/bytemaster333/usagemap/collector/tests/internal/sink"
)

// The Compose tests build and run the real image (collector/Dockerfile) as it
// is deployed: read-only root filesystem, non-root, the queue on a volume,
// mutual TLS to two writers behind one DNS name. They need Docker and are
// enabled with SCF_COLLECTOR_DOCKER=1 (Compose project scf-wsc, host ports
// 56170–56175 on 127.0.0.1; everything is removed at the end).

const (
	composeProject = "scf-wsc"
	imageTag       = "scf-wsc/scf-otelcol:test"
)

var (
	dockerHTTP    = "http://127.0.0.1:56170"
	dockerHealth  = "http://127.0.0.1:56171/"
	dockerMetrics = 56172
	writerAdmin   = map[string]string{"writer-a": "http://127.0.0.1:56173", "writer-b": "http://127.0.0.1:56174"}
)

func requireDocker(t *testing.T) {
	t.Helper()
	if os.Getenv("SCF_COLLECTOR_DOCKER") != "1" {
		t.Skip("set SCF_COLLECTOR_DOCKER=1 to run the Docker image and Compose tests")
	}
	if err := exec.Command("docker", "version").Run(); err != nil {
		t.Fatalf("docker not available: %v", err)
	}
}

func run(t *testing.T, env []string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out)
	}
	return string(out)
}

// buildImage builds collector/Dockerfile from the repository root (once per run).
func buildImage(t *testing.T) string {
	t.Helper()
	if img := os.Getenv("SCF_WSC_IMAGE"); img != "" {
		return img
	}
	run(t, nil, "docker", "build", "-q", "-f", "../Dockerfile", "-t", imageTag, "../..")
	return imageTag
}

// TestImageComponents: the image contains exactly the declared components.
func TestImageComponents(t *testing.T) {
	requireDocker(t)
	img := buildImage(t)
	compareGolden(t, []byte(run(t, nil, "docker", "run", "--rm", img, "components")))
	user := strings.TrimSpace(run(t, nil, "docker", "image", "inspect", "-f", "{{.Config.User}}", img))
	if user != "65532:65532" {
		t.Fatalf("image user %q, want 65532:65532 (non-root)", user)
	}
}

type composeEnv struct {
	t   *testing.T
	env []string
}

func (c *composeEnv) compose(args ...string) string {
	c.t.Helper()
	return run(c.t, c.env, "docker", append([]string{"compose", "-p", composeProject, "-f", "compose.yaml"}, args...)...)
}

func startCompose(t *testing.T) *composeEnv {
	t.Helper()
	img := buildImage(t)
	dir := t.TempDir()
	sinkBin := filepath.Join(dir, "writersink")
	cmd := exec.Command("go", "build", "-trimpath", "-o", sinkBin, "./cmd/writersink")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOWORK=off")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build writersink: %v\n%s", err, out)
	}
	ca, err := pki.NewCA("scf-test-ca")
	if err != nil {
		t.Fatal(err)
	}
	pkiDir := filepath.Join(dir, "pki")
	if err := os.Mkdir(pkiDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Containers run as uid 65532: test keys are world-readable (test only).
	if _, _, err := ca.WriteFiles(pkiDir, true, "writers.scf.test"); err != nil {
		t.Fatal(err)
	}
	c := &composeEnv{t: t, env: []string{"SCF_WSC_SINK_BIN=" + sinkBin, "SCF_WSC_PKI=" + pkiDir, "SCF_WSC_IMAGE=" + img}}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("collector logs:\n%s", c.compose("logs", "--no-color", "collector"))
		}
		c.compose("down", "-v", "--remove-orphans")
	})
	c.compose("up", "-d")
	c.waitHealthy()
	return c
}

func (c *composeEnv) waitHealthy() {
	c.t.Helper()
	waitFor(c.t, 60*time.Second, "collector container healthy", func() bool {
		resp, err := http.Get(dockerHealth)
		if err != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	})
}

func writerRecords(t *testing.T, writer string) []sink.Record {
	t.Helper()
	resp, err := http.Get(writerAdmin[writer] + "/records")
	if err != nil {
		return nil // writer down
	}
	defer resp.Body.Close()
	var recs []sink.Record
	if err := json.NewDecoder(resp.Body).Decode(&recs); err != nil {
		t.Fatalf("records of %s: %v", writer, err)
	}
	return recs
}

// routesAt counts the points per route a writer received for a phase prefix.
func routesAt(t *testing.T, writer, prefix string) map[string]int {
	out := map[string]int{}
	for _, r := range writerRecords(t, writer) {
		for _, rt := range pointRoutes(t, r) {
			if strings.HasPrefix(rt, prefix) {
				out[rt]++
			}
		}
	}
	return out
}

func sendPhase(t *testing.T, prefix string, n int) {
	t.Helper()
	now := time.Now()
	for i := range n {
		if err := otlpsend.HTTPMetrics(ctx(t), dockerHTTP, onePoint("load", prefix+letters(i), now, nil), meta(testTenant, now)); err != nil {
			t.Fatalf("%s%d: %v", prefix, i, err)
		}
	}
}

// waitPhase waits until all n points of the phase arrived (at the given
// writers) and fails on duplicates.
func waitPhase(t *testing.T, prefix string, n int, writers ...string) map[string]int {
	t.Helper()
	per := map[string]int{}
	waitFor(t, 120*time.Second, fmt.Sprintf("%d points %s at %v", n, prefix, writers), func() bool {
		total := map[string]int{}
		clear(per)
		for _, w := range writers {
			for rt, k := range routesAt(t, w, prefix) {
				total[rt] += k
				per[w] += k
			}
		}
		return len(total) == n
	})
	sum := 0
	for _, k := range per {
		sum += k
	}
	if sum != n {
		t.Errorf("%s: %d deliveries for %d points (duplicates)", prefix, sum, n)
	}
	return per
}

// TestComposeWriterFailoverQueueAndReadOnly repeats S-04 item 5B with mutual
// TLS and a DNS name: a killed writer loses nothing, the queue survives
// kill -9 of the container, the container writes nothing outside its queue
// volume, and a canary trace leaves no trace in the queue volume.
func TestComposeWriterFailoverQueueAndReadOnly(t *testing.T) {
	requireDocker(t)
	c := startCompose(t)

	// Phase 1: both writers up.
	sendPhase(t, "/one/", 20)
	per := waitPhase(t, "/one/", 20, "writer-a", "writer-b")
	t.Logf("phase 1 (both up): %v", per)

	// Phase 2: writer-a killed → everything at writer-b.
	c.compose("kill", "writer-a")
	sendPhase(t, "/two/", 20)
	start := time.Now()
	waitPhase(t, "/two/", 20, "writer-b")
	t.Logf("phase 2 (writer-a killed): 20/20 at writer-b after %s", time.Since(start).Round(time.Second))

	// Phase 3: writer-a back, writer-b killed → everything at writer-a.
	c.compose("start", "writer-a")
	c.compose("kill", "writer-b")
	sendPhase(t, "/three/", 20)
	start = time.Now()
	waitPhase(t, "/three/", 20, "writer-a")
	t.Logf("phase 3 (writer-b killed): 20/20 at writer-a after %s", time.Since(start).Round(time.Second))

	// Phase 4: no writer; 20 requests queue up; the container is killed with SIGKILL and restarted.
	c.compose("kill", "writer-a")
	sendPhase(t, "/four/", 20)
	// All 20 were acknowledged, so they are in the persistent queue (sized in bytes, C-114).
	waitFor(t, 30*time.Second, "20 queued", func() bool {
		v, _ := selfMetric(t, dockerMetrics, "otelcol_exporter_queue_size", nil)
		return v > 0
	})
	c.compose("kill", "-s", "SIGKILL", "collector")
	c.compose("start", "collector")
	c.waitHealthy()
	c.compose("start", "writer-b")
	start = time.Now()
	per = waitPhase(t, "/four/", 20, "writer-b")
	t.Logf("phase 4 (queue across SIGKILL): %v after %s", per, time.Since(start).Round(time.Second))

	// Canary trace through the container; then the queue volume must hold no canary.
	now := time.Now()
	if err := otlpsend.HTTPTraces(ctx(t), dockerHTTP, canaryTraces(now), meta(testTenant, now)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 60*time.Second, "span-derived metrics at writer-b", func() bool {
		for _, r := range writerRecords(t, "writer-b") {
			if strings.Contains(r.OTLPJSON, "scf.span.server.duration") {
				return true
			}
		}
		return false
	})
	for _, r := range writerRecords(t, "writer-b") {
		checkRecord(t, r, testTenant, "http.server.request.duration", "scf.span.server.duration", "scf.ingest.dropped")
	}
	vol := composeProject + "_queue"
	out, err := exec.Command("docker", "run", "--rm", "--network", "none", "-v", vol+":/q:ro", "alpine:3.22",
		"sh", "-c", "ls -la /q; grep -rlE 'CANARY|FORGED|203\\.0\\.113|/users/42' /q && echo FOUND || echo CLEAN").CombinedOutput()
	if err != nil {
		t.Fatalf("scan queue volume: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "CLEAN") {
		t.Fatalf("canary found in the queue volume:\n%s", out)
	}
	t.Logf("queue volume:\n%s", out)

	// Read-only root filesystem: nothing changed in the container outside the volume.
	// Mount points created for bind mounts (A /pki) are not writes by the process.
	id := strings.TrimSpace(c.compose("ps", "-q", "collector"))
	mounts := strings.Fields(run(t, nil, "docker", "inspect", "-f", "{{range .Mounts}}{{.Destination}} {{end}}", id))
	for line := range strings.Lines(run(t, nil, "docker", "diff", id)) {
		kind, path, _ := strings.Cut(strings.TrimSpace(line), " ")
		if kind == "A" && slices.Contains(mounts, path) {
			continue
		}
		t.Errorf("container filesystem changed outside the queue volume: %s", strings.TrimSpace(line))
	}
}
