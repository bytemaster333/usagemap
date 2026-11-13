routed IPv4 ranges 459655, IPv6 ranges 119798, seed 20261112

| sample | db | unknown (full) | unknown (truncated) | country changed by truncation (any) | changed, both known | known→unknown |
|---|---|---|---|---|---|---|
| ipv4_range_weighted (n=1000000) | dbip-lite | 0.00% | 0.00% | 0.17% | 0.17% | 0.00% |
| ipv4_range_weighted (n=1000000) | user-country | 0.09% | 0.09% | 0.10% | 0.10% | 0.00% |
| ipv4_address_weighted (n=1000000) | dbip-lite | 0.00% | 0.00% | 0.10% | 0.10% | 0.00% |
| ipv4_address_weighted (n=1000000) | user-country | 0.02% | 0.02% | 0.03% | 0.03% | 0.00% |
| ipv6_range_weighted (n=1000000) | dbip-lite | 0.00% | 0.00% | 0.27% | 0.27% | 0.00% |
| ipv6_range_weighted (n=1000000) | user-country | 0.10% | 0.10% | 0.25% | 0.25% | 0.00% |

| sample | DB-IP vs user-country disagree, full (both known) | truncated (both known) | full (any, incl. unknown) | truncated (any) |
|---|---|---|---|---|
| ipv4_range_weighted | 8.79% | 8.64% | 8.87% | 8.72% |
| ipv4_address_weighted | 4.34% | 4.27% | 4.35% | 4.29% |
| ipv6_range_weighted | 11.66% | 11.37% | 11.75% | 11.46% |

Top DB-IP country changes caused by truncation (full->truncated: count):
- ipv4_range_weighted: CA->US: 291, US->CA: 79, GB->US: 54, MX->US: 32, DE->GB: 29, GB->DE: 29, JP->US: 28, US->GB: 27, BR->US: 26, NL->DE: 25
- ipv4_address_weighted: CA->US: 166, US->CA: 115, GB->US: 46, ES->FR: 21, US->JP: 21, PL->FR: 20, MX->US: 17, JP->US: 15, FR->GB: 11, IT->FR: 11
- ipv6_range_weighted: IN->US: 173, MX->US: 77, GL->US: 40, RU->JP: 40, RU->US: 39, CA->US: 36, US->NL: 36, AU->NZ: 31, BS->US: 31, US->MX: 31
