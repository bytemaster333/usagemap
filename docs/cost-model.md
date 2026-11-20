# Cost model: lean Azure profile (C-123)

| | |
|---|---|
| Status | Estimate of 2026-11-13 for the full-size lean profile. The small single-VM profile ([`deployment-topology.md`](deployment-topology.md) §0: one burstable 2 vCPU / 8 GiB VM, one Standard SSD, one backup storage account, external DNS on a free plan) is not priced here; price its plan from the public retail price list before applying ([`guides/deploy-v1.md`](guides/deploy-v1.md)). |
| Prices | **Azure list prices, pay-as-you-go, in US$, excluding VAT**, read from the public Azure Retail Prices API on **2026-11-13** (queries in §5). Monthly = hourly × 730. |
| Layout | [`deployment-topology.md`](deployment-topology.md) §1 (C-123): `app-1`, optional `standby-1`, two backup accounts in two EU regions, Azure DNS. |
| Labels | **P** = list price read from the API on 2026-11-13; **E** = our estimate (usage volume × list price), with the assumption stated. |

Replaces the multi-provider figures of [`sla.md`](sla.md) §12 (research cost model, 2026-11-12) for production; those
remain in [`deployment-topology.md`](deployment-topology.md) §S3 for the scale-out profile.

## 1. Unit prices (West Europe unless stated)

| Item | Meter (API `productName` / `meterName`) | List price | Per month | Label |
|---|---|---|---|---|
| VM Standard_D8as_v5 (8 vCPU, 32 GiB), Linux | Virtual Machines Dasv5 Series / D8as v5 | $0.416 /h | **$303.68** | P |
| VM Standard_D4as_v5 (4 vCPU, 16 GiB), Linux — small size | same / D4as v5 | $0.208 /h | **$151.84** | P |
| VM Standard_D2as_v5 (2 vCPU, 8 GiB), Linux — standby | same / D2as v5 | $0.104 /h | **$75.92** | P |
| Same D8as_v5, 1-year reservation | Reservation, 1 Year | $2,248 per year | $187.33 (−38 %) | P |
| Premium SSD P6 (64 GiB), OS disk | Premium SSD Managed Disks / P6 LRS Disk | $11.23 /month | $11.23 | P |
| Premium SSD P15 (256 GiB), data disk | Premium SSD Managed Disks / P15 LRS Disk | $41.81 /month | $41.81 | P |
| Static Standard public IPv4 | IP Addresses / Standard IPv4 Static Public IP | $0.005 /h | $3.65 | P |
| Private endpoint | Virtual Network Private Link / Standard Private Endpoint | $0.01 /h | $7.30 | P |
| Private endpoint data processed | Standard Data Processed – Ingress / – Egress | $0.01 /GB each way | — | P |
| Blob storage, Hot ZRS, data stored | General Block Blob v2 / Hot ZRS Data Stored | West Europe $0.024 /GB, Sweden Central $0.023 /GB | — | P |
| Blob write operations, Hot ZRS | Hot ZRS Write Operations | $0.0675 (WE) / $0.0625 (SC) per 10,000 | — | P |
| Blob read operations, Hot ZRS | Hot ZRS Read Operations | $0.0043 (WE) / $0.004 (SC) per 10,000 | — | P |
| Inter-region data transfer (West Europe → Sweden Central) | Bandwidth / Standard Inter-Region Data Transfer | $0.02 /GB | — | P |
| Internet egress (default routing preference: Microsoft network) | Rtn Preference: MGN / Standard Data Transfer Out | first 100 GB/month free, then $0.087 /GB | — | P (tier boundary from the API's `tierMinimumUnits`) |
| Inter-availability-zone transfer (`app-1` zone 1 ↔ `standby-1` zone 2) | Rtn Preference: MGN / Standard Inter-Availability Zone Data Transfer Out / In | $0.01 /GB each way | — | P |
| Azure DNS public zone | Azure DNS / Public Zone (first 25) | $0.50 /zone/month | $0.50 | P |
| Azure DNS public queries | Azure DNS / Public Queries (first 1 bn) | $0.40 /million | — | P |
| Azure Bastion Basic (optional) | Azure Bastion / Basic Gateway | $0.19 /h | $138.70 | P |

The same API returns EUR prices with `currencyCode='EUR'`; for example the D8as_v5 is €0.3734/h (≈ €272.58/month).
Encryption at host, Trusted Launch, NSGs, the VNet and the managed identities carry no separate charge (not checked
against a meter — **E**).

## 2. Usage assumptions for backups and traffic (E)

At the design load of 1,000,000 page views/day (C-48) in steady state after 90 days:

| Quantity | Assumption | Figure |
|---|---|---|
| Database size on disk | Umami ≈ 1.05 GB/day × 90 days (C-109, S-11) + `scf` database ≈ 10 GB | ≈ 105 GB |
| One full backup in a repository | pgBackRest zstd, assumed 3 : 1 on this data | ≈ 35 GB |
| Current full backups kept | weekly full, time-based retention 35 days → up to 6 (C-29, C-112) | ≈ 210 GB |
| Differential backups kept | daily, block incremental, ≈ 1.5 GB each, up to ≈ 40 | ≈ 60 GB |
| WAL kept | ≈ 1 GB/day compressed × 42 days | ≈ 42 GB |
| Previous versions (14 days, C-110) | one expired full, its diffs and two weeks of WAL | ≈ 70 GB |
| Weekly logical dumps (repository 2 only) | 5 × ≈ 8 GB (indexes are not dumped; C-109: 77 % of Umami's size is indexes) | ≈ 40 GB |
| **Repository 1 / repository 2** | sum | **≈ 380 GB / ≈ 420 GB** |
| Write operations | WAL every ≤ 60 s (`archive_timeout`) ≈ 45,000 segments/month/repository plus backup bundles | ≈ 60,000 writes/month/repository |
| Data written to repository 2 (cross-region) | 4.3 fulls + 30 diffs + WAL + 4.3 dumps | ≈ 260 GB/month |
| Restore-drill reads (standby in West Europe ← repository 2 in Sweden Central) | weekly: one full + WAL | ≈ 195 GB/month |
| Internet egress | 202 answers and challenge responses are small; tracker files are immutable and cached by browsers | 50–150 GB/month |
| DNS queries | static records; resolvers cache | ≈ 5–10 million/month |

The small size (a few sites, well below the design load) uses the same layout with a database of a few GB, so storage,
transfer and query volumes are negligible.

## 3. Monthly totals

| Line | Production (D8as_v5 + standby) | Small (D4as_v5, no standby) | Label |
|---|---|---|---|
| `app-1` compute | 303.68 | 151.84 | P |
| `standby-1` compute | 75.92 | — | P |
| OS disks (P6) | 22.46 (×2) | 11.23 | P |
| Data disks (P15, 256 GB — C-109) | 83.62 (×2) | 41.81 | P |
| Public IPs | 10.95 (×3) | 7.30 (×2) | P |
| Private endpoints (×2) | 14.60 | 14.60 | P |
| Private-endpoint data processed | ≈ 10 | ≈ 1 | E |
| Backup storage, both repositories | ≈ 19 (380 GB × 0.024 + 420 GB × 0.023) | ≈ 1 | E |
| Blob operations | ≈ 1 | < 1 | E |
| Cross-region transfer (writes to and drill reads from repository 2) | ≈ 9 | < 1 | E |
| Azure DNS (2 zones + queries) | ≈ 3–5 | ≈ 1.5 | P + E |
| Internet egress | 0–4 | 0 | E |
| **Total per month** | **≈ US$555–565** | **≈ US$235** | |
| Optional: Azure Bastion Basic | + 138.70 | + 138.70 | P |
| Optional: small size with the standby VM | — | + 132.61 (≈ US$365) | P |
| Optional: 1-year reservation of `app-1` (D8as_v5) | − 116.35 | — | P |

Not included: two domains (≈ €15/year each, registrar not chosen), the OpenTofu state storage account (a few GB,
< $1), Azure support plans, VAT, staff time, drills that start extra VMs for a few hours (a timed rebuild drill
costs a few dollars of hourly-billed compute).

## 4. Against the earlier estimates

| Layout | Monthly | Source |
|---|---|---|
| Lean Azure profile, production (this page) | ≈ US$560 | Azure Retail Prices API, 2026-11-13 |
| Lean Azure profile, small size | ≈ US$235 | same |
| Azure 9-VM scale-out layout (`modules/azure-platform` defaults: 4 edges, 2 cores, monitoring, probe, egress proxy) | ≈ US$600–900 | estimate, not re-priced here |
| Multi-provider recommended tier (Hetzner/UpCloud/OVHcloud + Azure backups) | about €300, to be re-priced | [`sla.md`](sla.md) §12 (research, 2026-11-12) |

The lean profile is not much cheaper than the 9-VM layout at production size, because the single VM is sized at
the measured 8-vCPU shape and carries 256 GB Premium SSD on two hosts. What it saves is operational surface (one or
two hosts to patch instead of nine), not mainly money. The small size is where the saving is.

## 5. How the prices were read

Public, unauthenticated JSON API, 2026-11-13, `https://prices.azure.com/api/retail/prices` with these `$filter`
values (consumption prices unless stated):

```text
serviceName eq 'Virtual Machines' and armRegionName eq 'westeurope' and (armSkuName eq 'Standard_D8as_v5' or armSkuName eq 'Standard_D4as_v5' or armSkuName eq 'Standard_D2as_v5') and priceType eq 'Consumption'
serviceName eq 'Virtual Machines' and armRegionName eq 'westeurope' and armSkuName eq 'Standard_D8as_v5' and priceType eq 'Reservation'
serviceName eq 'Storage' and armRegionName eq 'westeurope' and productName eq 'Premium SSD Managed Disks' and (skuName eq 'P6 LRS' or skuName eq 'P15 LRS')
serviceName eq 'Virtual Network' and armRegionName eq 'westeurope' and productName eq 'IP Addresses'
productName eq 'Virtual Network Private Link' and armRegionName eq 'Global'
serviceName eq 'Storage' and armRegionName eq 'westeurope' and productName eq 'General Block Blob v2' and skuName eq 'Hot ZRS'
serviceName eq 'Storage' and armRegionName eq 'swedencentral' and productName eq 'General Block Blob v2' and skuName eq 'Hot ZRS'
serviceName eq 'Bandwidth' and armRegionName eq 'westeurope'
serviceName eq 'Azure DNS' and armRegionName eq 'Zone 1'
serviceName eq 'Azure Bastion' and armRegionName eq 'westeurope'
```

Linux prices are the rows with `productName` "Virtual Machines Dasv5 Series" (the "Cloud Services" rows are a
different product). The "Disk Mount" meters returned with the disks apply to shared disks and are not used. Re-read the
prices before ordering; the API is the source of truth, this page is a snapshot.
