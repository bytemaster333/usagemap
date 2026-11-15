// SPDX-License-Identifier: Apache-2.0

// Command rangelist-updater fetches the network-class range lists weekly into the edge node's local volume (C-38).
//
//	rangelist-updater -dir /var/lib/scf-rangelists [-config sources.json] [-interval 168h]   (interval 0 = once)
//
// Egress goes through HTTPS_PROXY (the egress proxy, C-10). Each fetch logs the source's SHA-256; a failed source
// keeps its previous list. The gateway re-reads the directory every minute (netclass.Watch), so no signal is needed.
// Exit codes (once mode): 0 at least one source fetched, 1 every source failed, 2 bad configuration.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/rangelist"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	client := &http.Client{Timeout: 90 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	code := run(ctx, os.Args[1:], os.Stdout, os.Stderr, client)
	stop()
	os.Exit(code)
}

// run is the command without process globals (tested in main_test.go).
func run(ctx context.Context, args []string, stdout, stderr io.Writer, client *http.Client) int {
	fs := flag.NewFlagSet("rangelist-updater", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dir := fs.String("dir", "/var/lib/scf-rangelists", "output directory (the gateway's GW_RANGELISTS_DIR)")
	cfgFile := fs.String("config", "", "JSON array of sources {name,class,url,format}; default: the built-in publisher list")
	interval := fs.Duration("interval", 0, "repeat every interval (e.g. 168h); 0 = run once")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *interval < 0 || (*interval > 0 && *interval < time.Hour) {
		fmt.Fprintln(stderr, "interval must be 0 (once) or at least 1h")
		return 2
	}
	log := slog.New(slog.NewJSONHandler(stdout, nil))
	srcs := rangelist.Defaults
	if *cfgFile != "" {
		b, err := os.ReadFile(*cfgFile)
		if err == nil {
			err = json.Unmarshal(b, &srcs)
		}
		if err != nil {
			fmt.Fprintln(stderr, "config:", err)
			return 2
		}
	}
	if err := rangelist.Validate(srcs); err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if err := os.MkdirAll(*dir, 0o755); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	u := &rangelist.Updater{Dir: *dir, Sources: srcs, Log: log, Client: client}
	for {
		st := u.Run(ctx)
		failed := 0
		for _, s := range st {
			if s.Error != "" {
				failed++
			}
		}
		if *interval == 0 {
			if failed == len(st) {
				return 1
			}
			return 0
		}
		t := time.NewTimer(*interval)
		select {
		case <-ctx.Done():
			t.Stop()
			return 0
		case <-t.C:
		}
	}
}
