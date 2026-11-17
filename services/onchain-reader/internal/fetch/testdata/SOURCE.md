# Recorded ledger data files (test fixtures)

Real Galexie `LedgerCloseMetaBatch` objects (XDR, zstd) of Stellar **mainnet** around the UTC midnight of
2024-06-01, copied byte for byte on 2026-11-16 with anonymous HTTPS GETs. Used by `realdata_test.go` (both store
layouts, ETag/MD5 and metadata checks, day assignment at midnight, identical counts from both layouts).

| Directory | Source (store root) | Objects | Layout (`.config.json`) |
|---|---|---|---|
| `aws-pubnet/` | `https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/pubnet` | ledgers 51920539–51920543, one per object | 1 ledger per batch, 64,000 batches per partition |
| `lightsail/` | `https://galexie.lightsail.network/v1` | ledgers 51920536–51920543 in one object | 8 ledgers per batch, 64,000 batches per partition |

Each object keeps its store key as its path below the directory, e.g.
`aws-pubnet/FCE801FF--51904000-51967999/FCE7C163--51920540.xdr.zst` was
`<aws root>/FCE801FF--51904000-51967999/FCE7C163--51920540.xdr.zst`. `.config.json` is the store's file as served.
`headers.json` holds the response headers the tests replay: `ETag` (equal to the object's MD5 in every case) and the
AWS `x-amz-meta-*` object metadata (the volatile `x-amz-meta-file-mtime` omitted). Ledger 51920539 closed at
2024-05-31T23:59:55Z, 51920540 at 2024-06-01T00:00:01Z; 51920542–51920543 carry three Soroban contract invocations.

**Licence / terms.** The content is the public Stellar mainnet ledger: transaction data that every Stellar node and
history archive publishes. AWS Open Data registry entry `aws-public-blockchain` (read 2026-11-16,
`https://github.com/awslabs/open-data-registry/blob/main/datasets/aws-public-blockchain.yaml`): free access, not
requester-pays; its licence link points to the LICENSE of `aws-samples/digital-assets-examples` (MIT-style, "free of charge").
Lightsail Network (Quasar, `https://quasar.lightsail.network/`): a free public endpoint with rate limits; no further
terms are published (UNVERIFIED, `references/stellar-facts-check-2026-11-16.md` §7) — the object is the same public
ledger data as the AWS copy, kept here only because it is the one public example of the eight-ledger layout.
No end-user data is added; account and contract identifiers in the ledgers are public chain data and are never
written by the tests.
