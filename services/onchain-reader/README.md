# onchain-reader

Reader and fetcher of the on-chain correlation. **Public Stellar ledger data files are the primary source** (decision
D3, register C-136, reversing ADR-0028's order; Hubble is the secondary source and is not built). The command counts, per
declared Soroban contract and UTC day, the figures stored in `scf.onchain_daily` (`db/migrations/0021_onchain.sql`)
with `data_source = 'ledger_files'` (wire-formats §p), and its `fetch` subcommand fills the local mirror of ledger files
from a public store (wire-formats §p.1, plan A1).

Counting is a batch command with no port, database or network: it reads files from local paths, writes JSON lines to
stdout and a one-line summary to stderr. `fetch` reads one public store over anonymous HTTPS and writes only the mirror.

## Input: ledger data files

The files are those written by Galexie (the Stellar ledger exporter): each object is one XDR `LedgerCloseMetaBatch`,
zstd-compressed, named `<hex>--<start>[-<end>].xdr.zst` (older exports: `.xdr.zstd`) inside partition directories
`<hex>--<start>-<end>/`, where `<hex>` is `0xFFFFFFFF − sequence` so the newest ledgers sort first (SEP-54). `fetch`
fills a mirror in exactly this layout; the reader walks any directory it is given and ignores other files
(`.config.json`, `.mirror.json`). When the single path is a mirror written by `fetch` and its index holds every
requested day complete, the reader reads only those days' files (with the neighbours' boundary batches), not the whole
7-day mirror.

## Fetching: `onchain-reader fetch` (wire-formats §p.1, plan A1)

```sh
onchain-reader fetch -network pubnet -dest /data/ledgers -from-day 2026-11-15 -to-day 2026-11-15
onchain-reader fetch -network testnet -source aws-testnet -dest /data/ledgers-testnet -from-day … -to-day …
```

| Flag | Meaning |
|---|---|
| `-source` | store root `https://…`; a URL ending in `/testnet` (e.g. `https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/testnet`) means the newest reset directory below it that has a `.config.json`; or `aws-pubnet` (default for pubnet), `lightsail`, `aws-testnet` (default for testnet); env `SCF_ONCHAIN_LEDGER_SOURCE_URL` |
| `-dest` | the mirror directory; env `SCF_ONCHAIN_LEDGER_DIR` |
| `-from-day`, `-to-day` | inclusive UTC days (at most 366) |
| `-network` | `pubnet` (default), `testnet` or a passphrase; must equal the store's `networkPassphrase` |
| `-parallel` | concurrent downloads (default 8, 1…64) |
| `-max-memory` | decompressed batches held at once by all workers together, in bytes (default 1 GiB) |
| `-retries` | retries per request (default 6): exponential backoff with jitter, `Retry-After` honoured; 429, 5xx and transport errors are retried, 404 and other 4xx are final |
| `-keep-days` | days before today (UTC) kept; older days and their files are pruned after the run (default 7; env `SCF_ONCHAIN_LEDGER_KEEP_DAYS`; 0 keeps everything) |
| `-ledgers-per-batch`, `-batches-per-partition`, `-file-ext` | only for a store **without** `.config.json` (pre-v23, `.xdr.zstd`): the layout given explicitly; refused for a store that has one |

Verified stores (`references/stellar-facts-check-2026-11-16.md`): AWS Open Data
`https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/pubnet` (mainnet from genesis, **one** ledger per
object, close times in the object metadata, not requester-pays; testnet under `…/ledgers/testnet/<reset-date>/`) and
Lightsail `https://galexie.lightsail.network/v1` (mainnet, **eight** ledgers per object, no metadata, rate-limited).

How it works:

1. **Layout from the store.** `.config.json` is read and checked (zstd, passphrase = `-network`); every key is derived
   from `ledgersPerBatch`/`batchesPerPartition` (`lake.Layout`). A store without it is exit 1 unless the explicit flags
   are given.
2. **Day → ledger range.** Keys are by sequence, so the first batch whose last ledger closed at or after a UTC
   midnight is searched: a probe is a `HEAD` answered from `x-amz-meta-*-close-time` (AWS) or a download and decode
   (Lightsail; the body is kept and reused if the batch is needed). The search extrapolates from the observed close
   rate, then interpolates with a bisection fallback (≈ 15–20 probes from genesis to a 2026 day; consecutive days reuse
   the probes). A day's range runs from the batch with the previous day's last ledger to the batch with the next day's
   first ledger, which the reader needs to call the day `complete`. A day whose next midnight is not in the store yet
   is exit 1.
3. **Download.** Only missing files, `-parallel` at a time; each is checked before it lands: MD5 against a single-part
   `ETag`, the object metadata (passphrase, ledger range, close times) where present, and that it decodes as a
   `LedgerCloseMetaBatch` of exactly its expected, contiguous ledger range whose ledgers match their own headers and
   chain inside the batch (`internal/lake/verify.go`). Files are written atomically (temporary name, fsync, rename,
   directory fsync). Memory: a compressed object is at most 64 MiB (a larger declared length is refused
   unread), and decompression reserves the batch's declared size (else `-max-batch-bytes`) in one budget shared by all
   workers (`-max-memory`, default 1 GiB) — so at most `-parallel` × 64 MiB + `-max-memory` is held at once.
4. **Resumable.** The mirror's `.mirror.json` records the store (root and config) and each day's batch range as soon as
   it is known, and `complete` once every file is in; an interrupted run leaves only whole files, the next run removes
   stale temporary files and downloads what is missing without searching again. `.fetch.lock` (flock) keeps two
   fetches from writing one mirror.
5. **Never mixed.** A mirror belongs to one store: a different root or config is exit 1. After a testnet reset
   `aws-testnet` resolves to the new store and the run fails loudly ("the testnet store moved … testnet was reset");
   a dated testnet root that ends before the requested day names the newer store. Empty the mirror (or use another
   `-dest`) to switch.
6. **Retention.** Days older than `-keep-days` before today are dropped with their files unless a kept day still
   needs a shared boundary batch.

Volume (mainnet, LIKELY from two samples): ≈ 17,280 ledgers and 2.7–3 GB per day — ≈ 17k objects from AWS, ≈ 2.2k from
Lightsail — so a 7-day mirror needs ≈ 20 GB of disk. HTTPS only (redirects off HTTPS refused), no credentials, a generic
User-Agent; the fetcher never sees contract ids or tenant data. On stderr: `onchain-reader fetch: store <root>`, then
one line of counts only (`days= files= downloaded= present= bytes= probes= pruned=`, parsed by the jobs service).

## Output

One line per requested contract and per UTC day seen in the files, including days with no invocation (that is
information for the trust score), sorted by day, then contract:

```json
{"contract":"CCW67…MI75","day":"2026-11-10","invocations":2,"successful_invocations":2,"distinct_invokers":2,"data_source":"ledger_files","ledgers_in_day":12,"ledger_first":65408000,"ledger_last":65408011,"complete":false,"anchor_ledger":null,"anchor_hash":null}
```

The JSON names are the `scf.onchain_daily` columns; the contract is given as its strkey (the caller maps it to
`contract_ref` via `scf.declared_contracts`). `ledgers_in_day` is the number of distinct ledgers of that day that were
read, `ledger_first`/`ledger_last` its lowest and highest sequence. `complete` is true only when the day's ledgers
are contiguous **and** the run also saw the ledger just before `ledger_first` and just after `ledger_last` (they
belong to the neighbouring days — ledgers outside `-from-day`/`-to-day` are not counted but are noted for this), so
nothing of the day can be missing. The caller stores a row only for complete days; the mirror must therefore include
the last ledger of the previous day and the first of the next.

**Day anchor (register C-144).** Every ledger is checked against its own header (header, transaction-set and
result-set hashes) and chained to its predecessor, so a store cannot alter one ledger — but a store serving a whole
forged, self-consistent chain would pass those checks. For a complete day the line therefore names its anchor:
`anchor_ledger` = `ledger_last` + 1 (the first ledger after the day) and `anchor_hash`, that ledger's hash (64 hex).
Through the verified chain this one hash commits to every header of the day, its transactions and results and the
close times that bound it. The jobs service compares it with Horizon's `GET /ledgers/{anchor_ledger}` `hash` before it
uses the day's counts and refuses the day on a mismatch. An incomplete day has both fields `null`.

Definitions:

- **invocation** — a top-level `InvokeHostFunction` operation whose host function is `InvokeContract` on a requested
  contract. Contract-to-contract sub-calls and contract creation/upload are **not** counted.
- **successful** — its transaction succeeded (Soroban transactions carry exactly one operation; fee-bump transactions
  are judged by the inner result).
- **invoker** — the operation's source account, else the transaction's source (for a fee-bump: the inner transaction's
  source, not the fee sponsor); muxed accounts count as their underlying account. With relayers or smart-wallet
  patterns this is the submitting account, so `distinct_invokers` is a lower bound of distinct end users.

Results are matched to envelopes by transaction hash, which needs the right network passphrase (`-network`); a result
that matches no envelope makes the run fail (exit 1). A ledger present in two files is counted once.

## Usage map: `onchain-reader usage` (Ecosystem Usage Map, migration 0075)

```sh
printf '%s %s\n' 019a…-project-id CA…contract | onchain-reader usage -network pubnet -groups - -from-day 2026-11-09 -to-day 2026-11-15 /data/ledgers
```

Job `usage_map` of `services/jobs` runs it daily (07:30 UTC) over the same mirror for **every registry project that lists
contract ids** (`scf.registry_projects.contract_ids`), tenant or not. Input: `<group> <contract>` pairs on stdin (the
group is an opaque label, `^[A-Za-z0-9_-]{1,64}$`; the job uses the registry project id; a contract may be in several
groups). `-from-day`/`-to-day` are required (at most 32 days: distinct sets are held in memory). Output, JSON lines in
this order (`internal/usage`):

| `kind` | One line per | Fields |
|---|---|---|
| `day` | UTC day seen | `ledgers_in_day`, `ledger_first`, `ledger_last`, `complete`, `anchor_ledger`, `anchor_hash` (as the counting command; checked against Horizon by the job, C-144) |
| `group` | group × day seen (zeros included) | `invocations`, `successful_invocations`, `distinct_invokers` (distinct over all the group's contracts, not a sum), `contract_calls`, `contracts_invoked` |
| `contract` | requested contract × day seen | `invocations`, `successful_invocations`, `distinct_invokers`, `contract_calls`, `successful_contract_calls` |
| `function` | contract × function × caller kind × day, non-zero | `function`, `caller_kind` (`account` \| `contract`), `calls`, `successful_calls` |
| `week` | group × ISO week whose 7 days are all complete in this run | `week_start` (Monday), `active_accounts`, `active_accounts_successful`, `invocations`, `successful_invocations`, `contract_calls` |

Definitions (beyond the counting command's):

- **Caller kind `account`**: the top-level invocation (an operation's source is always an account). **`contract`**: a call
  of a requested contract made by another contract, as far as the ledger files show it without diagnostic events — a
  node of the transaction's Soroban authorization trees that is a sub-invocation, or a root that is not the top-level
  call itself. Only calls that need some address's authorisation appear there, so contract calls are a **lower bound**;
  equal nodes (contract, function, arguments) of one transaction count once (two signers authorise the same call).
- **Function names** are Soroban symbols; a name that is not a valid symbol counts as `(invalid)`; per contract and day at
  most 64 names are kept (by calls), the rest as `(other)` (anyone may call any name; the output stays bounded).
- **Weekly active accounts (SCF Growth Hack, official rules: "an active account means the account that initiated at
  least one operation")**: distinct invokers (operation source, else transaction source; fee-bump: the inner source,
  never the sponsor; muxed → underlying account) of the group's contracts in the ISO week, Monday 00:00 – Sunday 24:00
  UTC. **Ambiguities, both stated:** the rules do not say whether a failed transaction's operation counts as "initiated"
  — `active_accounts` counts every operation included in a ledger, `active_accounts_successful` only successful ones;
  and they do not say which operations belong to a project — here, only `InvokeHostFunction` calls of its listed
  contracts (payments to its accounts, DEX trades of its assets and smart-wallet users behind a relayer are not seen).
  A week is reported only when all seven days are complete **in one run** (distinct accounts cannot be added across
  runs); with the mirror's 7-day retention the job reads the whole week on the Monday after it.

Privacy as below: accounts are counted in memory and discarded; the summary line
(`onchain-reader usage: files= ledgers= … invocations= contract_calls= weeks=`) has counts only
(`TestOutputCarriesNoAccount`, `TestUsageSubcommand`). `lakegen` specs accept `"function"` and `"auth"` (authorization
trees) for fixtures of this mode.

## Protocol interactions: `onchain-reader protocols` (migration 0082)

```sh
printf 'group p-019a… CA…app\nprotocol blend CA…pool\n' | onchain-reader protocols -network pubnet -input - -from-day 2026-11-13 -to-day 2026-11-15 /data/ledgers
```

Job `protocol_usage` of `services/jobs` runs it daily (07:45 UTC) over the same mirror: groups are every registry project
that lists contract ids (`p-<id>`) and every opted-in tenant's verified contracts (`t-<id>`, the §p list); protocols are
the curated, versioned registry `services/jobs/src/onchain/protocols/registry.json` (Blend, Soroswap, DeFindex,
Aquarius, Reflector on mainnet and testnet, each id with its official source at a pinned commit or its official docs).
Input lines: `group <label> <C…>` and `protocol <label> <C…>` (a contract belongs to one protocol). Output, JSON lines
in this order (`internal/protocols`):

| `kind` | One line per | Fields |
|---|---|---|
| `day` | UTC day seen | as the usage map (completeness, anchor; checked against Horizon by the job) |
| `group` | group × day seen (zeros included) | `transactions`, `successful_transactions`: transactions touching the group's contracts |
| `protocol` | group × day × protocol, non-zero | the group's transactions that also touch the protocol |
| `network` | protocol × day seen (zeros included) | every transaction of the network touching the protocol |

Definitions:

- A transaction is considered when it has an `InvokeHostFunction` operation (TTL extension and restore are not).
- It **touches** a contract through its top-level `InvokeContract`, any contract node of its authorization trees, or
  any `ContractData` key (instance included) of its Soroban footprint, read-only or read-write — Soroban loads the
  instance of every contract it runs, so the footprint names every contract executed or read. Fee-bump: the inner
  transaction's data.
- It counts for protocol P of group G when it touches G and a contract of P that is **not** one of G's own (a project
  that is the protocol does not interact with itself). Failed transactions count (`successful_transactions` apart).
- **Lower bound**: contracts a protocol creates at run time (pools, pairs, vaults) and the registry does not list are
  not seen.

Privacy: no account is read at all; a transaction's contracts are held only while it is examined; only counts per group
label, day and protocol label leave the reader (`TestProtocolInteractions`). Summary on stderr: `onchain-reader
protocols: files= ledgers= … soroban_transactions= group_transactions= protocol_transactions=`. `lakegen` specs accept
`"footprint": ["label", …]` (contracts whose instance the footprint lists) for fixtures of this mode.

## Local Quickstart (development only)

A [Stellar Quickstart](https://github.com/stellar/quickstart) started with `--local --enable core,rpc,galexie` serves
its ledger store over plain HTTP at `http://localhost:8000/ledger-meta` (SEP-54: `.config.json`, zstd, one ledger per
file, 64,000 files per partition, from ledger 2; stellar/quickstart README and `local/nginx/etc/conf.d/ledger-meta.conf`
at commit 35a3f46e, 2026-11-12). The reader can mirror and count it for local development:

```sh
docker run --rm -d -p 8000:8000 --name stellar stellar/quickstart --local --enable core,rpc,galexie
# … deploy and call your contracts against http://localhost:8000/rpc …
onchain-reader fetch -network standalone -source quickstart -dest ./qs-ledgers            # newest ≤ 100,000 ledgers
printf 'group my-app CA…\nprotocol blend CB…\n' | \
  onchain-reader protocols -network standalone -input - -from-day "$(date -u +%F)" -to-day "$(date -u +%F)" ./qs-ledgers
onchain-reader -network standalone -contract CA… -from-day "$(date -u +%F)" -to-day "$(date -u +%F)" ./qs-ledgers
```

- `-network standalone` (alias `quickstart`) is the passphrase `Standalone Network ; February 2017`; a randomised
  Quickstart passphrase (`--randomize-network-passphrase`) is given in full. `fetch` copies, instead of whole UTC days,
  the newest `-max-ledgers` ledgers present (default 100,000; the newest file is left for the next run, as it may still
  be in the making), each verified like any download (decodes as its expected ledger, headers and chain checked).
  Plain `http://` is accepted **only** for the standalone network; `-source quickstart` with another network is a
  usage error; a dev mirror and a network mirror are never mixed (`.mirror.json` carries `"dev": true`).
- **Labelled dev, never production figures.** With the standalone passphrase every output line of every mode carries
  `"dev": true` and the summary ends `network=standalone dev=1`. The jobs service's strict parsers refuse any line with
  an unknown field, so development figures can never be stored (its configuration accepts `public` and `testnet` only).
  A Quickstart's day is normally incomplete (`complete: false`): the figures are for checking an integration, not
  daily statistics.
- Test: `TestQuickstartSidecar`, `TestQuickstartRefusals` (`cmd/onchain-reader/quickstart_test.go`) against a fixture
  server that answers like the Quickstart (plain HTTP, no ETag, no object metadata).

## Privacy

Invoker keys are held in memory for one run only, to count distinct values; they are never written, logged or returned
(`TestOutputCarriesNoInvokerIdentity`, `TestRunWritesOnchainDailyRows`, the integration test). The summary on stderr has
counts only. The mirror itself is a copy of the public ledger (it contains every account of every transaction, as any
Stellar node's history does); it is never copied into the database, and only the per-contract counts leave the reader.

## Usage

```sh
onchain-reader -network pubnet -contracts declared.txt -from-day 2026-11-10 -to-day 2026-11-10 /data/ledgers
```

| Flag | Meaning |
|---|---|
| `-contract C…` | contract to count (repeatable) |
| `-contracts FILE` | one contract strkey per line; `#` comments and blank lines ignored; `-` reads stdin (how the jobs service passes them) |
| `-network` | `pubnet` (default), `testnet`, or a passphrase |
| `-from-day`, `-to-day` | inclusive UTC day bounds; ledgers outside are skipped |
| `-max-batch-bytes` | refuse a batch that decompresses to more (default 512 MiB; zip-bomb guard) |

**Integrity.** Every ledger read is checked against its own header — header hash = SHA-256 of the
header XDR, `txSetHash` = SHA-256 of the generalized transaction set, `txSetResultHash` = SHA-256 of the result set in
apply order — and every two consecutive ledgers read must chain (`previousLedgerHash`); otherwise exit 1 and no row.
Pre-protocol-20 ledgers (`LedgerCloseMeta` v0) are refused (they hold no contract invocation). Verified against real
mainnet ledgers of both stores (`internal/lake/verify_real_test.go`). What this does not cover: a store that serves a
whole forged chain consistently; that needs one ledger hash of the day from an independent source.

Exit codes (reader and `fetch`): `0` success, `1` a file or ledger could not be read, results did not match envelopes,
or (fetch) a requested day is not complete in the mirror, `2` usage error.

## How it is run (C-42, C-136)

Job `onchain_correlation` of `services/jobs` runs it daily (06:00 UTC) as a child process: the binary is built into the
jobs image (`/usr/local/bin/onchain-reader`); `fetch` fills the mirror at `SCF_ONCHAIN_LEDGER_DIR` for D−1 and the
missing days of the last 7 (when `SCF_ONCHAIN_LEDGER_SOURCE_URL` is set; egress per C-10 to that store only), then the
contracts — the §p list: `declared_contracts` with `status = 'verified'`, not removed, **`conflict_since IS NULL`**, on
`SCF_STELLAR_NETWORK`, of opted-in tenants that are not removed — go on stdin, and the complete days are upserted into
`scf.onchain_daily` as `scf_jobs` under each tenant's context; a complete `ledger_files` day replaces a `hubble` row
(D3). Without a mirror the job is disabled and the trust score reports the A3 badge as `unavailable`. The stand-alone
image `usagemap/onchain-reader` stays available for manual runs.

`internal/fixture/lakegen` writes a synthetic lake from a JSON description (the jobs service's integration test and
this module's integration test use it with this binary). Its `-demo-days N` mode writes the local stack's fixture
mirror (the Dockerfile's `lakegen` target, Compose one-shot `onchain-fixture`: N complete days before today, testnet,
contracts `smoke-contract` and `smoke-conflict`); that image is never a production image.

## Build and test

```sh
eval "$(mise env -s bash)"
cd services/onchain-reader && go vet ./... && go test -race ./...                       # unit, no network
cd services/onchain-reader/integration && GOWORK=off go test -count=1 ./...             # real PostgreSQL (Docker)
SCF_ONCHAIN_LIVE=1 go test -count=1 -run TestLiveDayBoundary -v ./internal/fetch/       # optional: the live stores
docker build -t usagemap/onchain-reader:dev services/onchain-reader   # from the repository root
```

Unit tests need no network. `internal/fixture` builds `LedgerCloseMeta` V1/V2 ledgers with plain, muxed and fee-bump
transactions (results in a different order than the envelopes). `internal/fetch` serves synthetic stores of both
layouts over a local TLS server (S3-style metadata, ETags, listing, fault injection): both layouts
(`TestFetchBothLayouts`), day boundaries (`TestDayBoundaries`), resume after an interrupt (`TestResumeAfterInterrupt`),
a store without `.config.json` (`TestMissingConfig`), network and config checks, a day not in the store yet, testnet
discovery and reset (`TestTestnetDiscoveryAndReset`), retries/backoff and download verification, retention and the
mirror lock. `TestRealFilesBothLayouts` uses **real** mainnet objects recorded from both public stores
(`internal/fetch/testdata`, source and terms in `testdata/SOURCE.md`): ETag/MD5 and metadata checks, a midnight
boundary, identical counts from the one-ledger and the eight-ledger layout. `cmd/onchain-reader` tests run
`fetch` then the reader end to end, every exit code, and the reader over the recorded files. The integration module
(`integration/`, own `go.mod` with pgx, Compose project `scf-d1-oc-it`, PostgreSQL on 127.0.0.1:26410) runs store →
`fetch` → mirror → the §p contract list as `scf_jobs` → reader → upsert into `onchain_daily`, with verified, conflicted,
claimed, other-network and opted-out contracts and a `hubble` row that a complete day replaces. `TestLiveDayBoundary`
(`SCF_ONCHAIN_LIVE=1`) finds yesterday's midnight in the AWS and Lightsail stores and downloads one boundary batch from
each (a few MB). `TestRealLedgerFiles` (`SCF_ONCHAIN_SAMPLE_DIR`) counts a local copy of real files.

Dependencies: the Go Stellar SDK (`github.com/stellar/go-stellar-sdk` v0.8.0, Apache-2.0: XDR, strkey, transaction
hashing) and `github.com/klauspost/compress` (BSD-3-Clause: zstd); the fetcher uses the standard library only. The
integration module adds `github.com/jackc/pgx/v5` (MIT), test-only.

## Limits

- Top-level invocations only (no sub-invocations, no events).
- One run holds the distinct-invoker sets of its days in memory; run it per day.
- The ledger files carry no proof that they are the ledgers the network closed (SEP-54 scope); both public stores are
  third-party operated (Goldsky for AWS, Lightsail), with no SLA stated.
- Lightsail's rate limits and terms for automated daily bulk download are not published (UNVERIFIED): AWS is the default.
