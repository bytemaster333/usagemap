// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fetch"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
	"github.com/stellar/go-stellar-sdk/network"
)

// getenv reads the flag defaults (a variable for tests).
var getenv = os.Getenv

// httpClient is the fetch client (tests trust their own TLS server through it).
var httpClient *http.Client

// now is the clock of the mirror's retention (a variable for tests).
var now = time.Now

func envInt(name string, dflt int) (int, error) {
	v := getenv(name)
	if v == "" {
		return dflt, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer", name)
	}
	return n, nil
}

// runFetch is `onchain-reader fetch`: fill the mirror with the requested days (wire-formats §p.1).
func runFetch(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("onchain-reader fetch", flag.ContinueOnError)
	fs.SetOutput(stderr)
	keepDefault, err := envInt("SCF_ONCHAIN_LEDGER_KEEP_DAYS", 7)
	if err != nil {
		fmt.Fprintf(stderr, "onchain-reader fetch: %v\n", err)
		return 2
	}
	source := fs.String("source", getenv("SCF_ONCHAIN_LEDGER_SOURCE_URL"),
		"store root (https://…) or aws-pubnet, aws-testnet (newest testnet store), lightsail; default by -network (env SCF_ONCHAIN_LEDGER_SOURCE_URL)")
	dest := fs.String("dest", getenv("SCF_ONCHAIN_LEDGER_DIR"), "mirror directory (env SCF_ONCHAIN_LEDGER_DIR)")
	net := fs.String("network", "pubnet", "pubnet, testnet or a network passphrase")
	from := fs.String("from-day", "", "first UTC day (YYYY-MM-DD), inclusive")
	to := fs.String("to-day", "", "last UTC day (YYYY-MM-DD), inclusive")
	parallel := fs.Int("parallel", 8, "concurrent downloads")
	retries := fs.Int("retries", 6, "retries per request (exponential backoff with jitter; Retry-After honoured)")
	keep := fs.Int("keep-days", keepDefault, "days before today (UTC) kept in the mirror; 0 keeps all (env SCF_ONCHAIN_LEDGER_KEEP_DAYS)")
	maxBytes := fs.Int64("max-batch-bytes", lake.DefaultMaxDecompressed, "refuse a batch that decompresses to more bytes")
	maxMemory := fs.Int64("max-memory", fetch.DefaultMaxMemory, "decompressed batches held at once by all workers together (bytes)")
	lpb := fs.Uint("ledgers-per-batch", 0, "store without .config.json only: ledgers per object")
	bpp := fs.Uint("batches-per-partition", 0, "store without .config.json only: objects per partition")
	ext := fs.String("file-ext", ".xdr.zstd", "store without .config.json only: object file extension")
	devMax := fs.Int("max-ledgers", fetch.DefaultDevMaxLedgers, "-network standalone only: newest ledgers copied from the development store")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	usage := func(msg string) int {
		fmt.Fprintf(stderr, "onchain-reader fetch: %s\n", msg)
		return 2
	}
	switch {
	case fs.NArg() != 0:
		return usage("unexpected arguments")
	case *dest == "":
		return usage("-dest (or SCF_ONCHAIN_LEDGER_DIR) is required")
	case (*from == "" || *to == "") && !fetch.IsStandalone(passphrase(*net)):
		return usage("-from-day and -to-day are required")
	case *devMax < 1 || *devMax > 1_000_000:
		return usage("-max-ledgers must be 1…1000000")
	case *parallel < 1 || *parallel > 64:
		return usage("-parallel must be 1…64")
	case *retries < 0 || *retries > 20:
		return usage("-retries must be 0…20")
	case *keep < 0:
		return usage("-keep-days must not be negative")
	case (*lpb == 0) != (*bpp == 0):
		return usage("-ledgers-per-batch and -batches-per-partition go together")
	case *lpb > 1<<20 || *bpp > 1<<20:
		return usage("-ledgers-per-batch and -batches-per-partition must be at most 1048576")
	}
	if !fetch.IsStandalone(passphrase(*net)) {
		if err := fetch.ValidateDays(*from, *to); err != nil {
			return usage(err.Error())
		}
	}
	var override *fetch.StoreConfig
	if *lpb != 0 {
		override = &fetch.StoreConfig{Compression: "zstd", LedgersPerBatch: uint32(*lpb), BatchesPerPartition: uint32(*bpp), FileExt: *ext}
		if err := override.Layout().Validate(); err != nil {
			return usage(err.Error())
		}
	}
	pass := passphrase(*net)
	if fetch.IsStandalone(pass) || *source == "quickstart" {
		return runFetchDev(*source, *dest, pass, *devMax, *retries, *maxBytes, stderr)
	}
	res, err := fetch.Run(baseCtx, fetch.Options{
		Source: *source, Dest: *dest, FromDay: *from, ToDay: *to, Passphrase: pass,
		Testnet: pass == network.TestNetworkPassphrase, Parallel: *parallel, Retries: *retries, KeepDays: *keep,
		MaxBatchBytes: *maxBytes, MaxMemory: *maxMemory, Override: override, Client: httpClient, Now: now,
	})
	// Summary: the public store root, then one line of counts only (parsed by the jobs service).
	if res.Source != "" {
		fmt.Fprintf(stderr, "onchain-reader fetch: store %s\n", res.Source)
	}
	fmt.Fprintf(stderr, "onchain-reader fetch: days=%d files=%d downloaded=%d present=%d bytes=%d probes=%d pruned=%d\n",
		res.Days, res.Batches, res.Downloaded, res.Present, res.Bytes, res.Probes, res.Pruned)
	if err != nil {
		fmt.Fprintf(stderr, "onchain-reader fetch: %v\n", err)
		var moved *fetch.MovedError
		if errors.As(err, &moved) {
			fmt.Fprintln(stderr, "onchain-reader fetch: refusing to mix stores in one mirror")
		}
		return 1
	}
	return 0
}

// runFetchDev is `fetch -network standalone [-source quickstart|URL]`: copy the newest ledgers of a local development
// store (a Stellar Quickstart with galexie enabled) into the mirror (fetch.RunDev). The mirror is marked dev and every
// reader output line over it carries "dev": true. -source quickstart with another network is a usage error.
func runFetchDev(source, dest, pass string, maxLedgers, retries int, maxBytes int64, stderr io.Writer) int {
	if !fetch.IsStandalone(pass) {
		fmt.Fprintln(stderr, "onchain-reader fetch: -source quickstart needs -network standalone (development data)")
		return 2
	}
	res, err := fetch.RunDev(baseCtx, fetch.DevOptions{Source: source, Dest: dest, Passphrase: pass,
		MaxLedgers: maxLedgers, Retries: retries, MaxBatchBytes: maxBytes, Client: httpClient, Now: now})
	if res.Source != "" {
		fmt.Fprintf(stderr, "onchain-reader fetch: store %s (development network: figures are labelled dev)\n", res.Source)
	}
	fmt.Fprintf(stderr, "onchain-reader fetch: days=0 files=%d downloaded=%d present=%d bytes=%d probes=%d pruned=0 dev=1\n",
		res.Batches, res.Downloaded, res.Present, res.Bytes, res.Probes)
	if err != nil {
		fmt.Fprintf(stderr, "onchain-reader fetch: %v\n", err)
		return 1
	}
	return 0
}
