### Per dashboard combination (all 9 endpoints pooled; seconds)

| mode | conc | site | range | filter | n | p50 | p95 | worst endpoint p95 | pass? | non-200 |
|---|---|---|---|---|---|---|---|---|---|---|
| warm | 1 | large | 24h | none | 90 | 0.29 | 0.36 | 0.38 (stats) | yes | 0 |
| warm | 1 | large | 24h | tag | 90 | 0.27 | 0.51 | 0.52 (stats) | yes | 0 |
| warm | 1 | large | 7d | none | 90 | 1.79 | 3.34 | 3.75 (stats) | NO | 0 |
| warm | 1 | large | 7d | tag | 90 | 2.25 | 4.57 | 5.01 (stats) | NO | 0 |
| warm | 1 | large | 14d | none | 27 | 5.89 | 14.20 | 15.26 (stats) | NO | 0 |
| warm | 1 | large | 14d | tag | 27 | 4.34 | 7.06 | 7.50 (stats) | NO | 0 |
| warm | 1 | large | 30d | none | 9 | 11.13 | 31.47 | 43.07 (stats) | NO | 0 |
| warm | 1 | large | 30d | tag | 9 | 5.94 | 21.32 | 30.91 (stats) | NO | 0 |
| warm | 1 | large | 90d | none | 9 | 17.92 | 23.57 | 24.29 (stats) | NO | 0 |
| warm | 1 | large | 90d | tag | 9 | 18.79 | 22.61 | 23.51 (stats) | NO | 0 |
| warm | 1 | medium | 24h | none | 90 | 0.06 | 0.07 | 0.07 (metrics:browser) | yes | 0 |
| warm | 1 | medium | 24h | tag | 90 | 0.05 | 0.08 | 0.09 (stats) | yes | 0 |
| warm | 1 | medium | 7d | none | 90 | 0.29 | 0.42 | 0.43 (stats) | yes | 0 |
| warm | 1 | medium | 7d | tag | 90 | 0.25 | 0.56 | 0.64 (stats) | yes | 0 |
| warm | 1 | medium | 14d | none | 90 | 0.67 | 0.81 | 0.83 (stats) | yes | 0 |
| warm | 1 | medium | 14d | tag | 90 | 0.49 | 1.53 | 1.63 (stats) | NO | 0 |
| warm | 1 | medium | 30d | none | 27 | 3.30 | 10.03 | 10.51 (stats) | NO | 0 |
| warm | 1 | medium | 30d | tag | 27 | 1.75 | 4.77 | 5.67 (stats) | NO | 0 |
| warm | 1 | medium | 90d | none | 9 | 24.46 | 33.96 | 35.91 (stats) | NO | 0 |
| warm | 1 | medium | 90d | tag | 9 | 15.34 | 120.87 | 183.39 (stats) | NO | 0 |
| warm | 1 | small | 24h | none | 90 | 0.01 | 0.02 | 0.02 (metrics:country) | yes | 0 |
| warm | 1 | small | 24h | tag | 90 | 0.01 | 0.02 | 0.02 (stats) | yes | 0 |
| warm | 1 | small | 7d | none | 90 | 0.03 | 0.04 | 0.04 (metrics:country) | yes | 0 |
| warm | 1 | small | 7d | tag | 90 | 0.03 | 0.05 | 0.07 (metrics:browser) | yes | 0 |
| warm | 1 | small | 14d | none | 90 | 0.04 | 0.06 | 0.06 (metrics:os) | yes | 0 |
| warm | 1 | small | 14d | tag | 90 | 0.04 | 0.06 | 0.07 (stats) | yes | 0 |
| warm | 1 | small | 30d | none | 90 | 0.07 | 0.08 | 0.08 (metrics:country) | yes | 0 |
| warm | 1 | small | 30d | tag | 90 | 0.07 | 0.11 | 0.11 (stats) | yes | 0 |
| warm | 1 | small | 90d | none | 90 | 0.13 | 0.18 | 0.19 (metrics:browser) | yes | 0 |
| warm | 1 | small | 90d | tag | 90 | 0.11 | 0.19 | 0.20 (stats) | yes | 0 |
| conc | 10 | large | 24h | none | 90 | 1.07 | 4.58 | 5.29 (metrics:browser) | NO | 0 |
| conc | 10 | large | 24h | tag | 90 | 1.37 | 2.79 | 3.01 (metrics:os) | NO | 0 |
| conc | 10 | medium | 24h | none | 90 | 0.14 | 0.38 | 0.49 (metrics:browser) | yes | 0 |
| conc | 10 | medium | 24h | tag | 90 | 0.16 | 0.29 | 0.34 (metrics:browser) | yes | 0 |
| conc | 10 | medium | 7d | none | 90 | 1.13 | 3.28 | 3.87 (metrics:browser) | NO | 0 |
| conc | 10 | medium | 7d | tag | 90 | 1.17 | 2.19 | 2.93 (stats) | NO | 0 |
| conc | 10 | medium | 14d | none | 90 | 2.58 | 5.32 | 6.53 (stats) | NO | 0 |
| conc | 10 | medium | 14d | tag | 90 | 2.32 | 6.32 | 7.52 (stats) | NO | 0 |
| conc | 10 | small | 24h | none | 90 | 0.14 | 0.19 | 0.20 (stats) | yes | 0 |
| conc | 10 | small | 24h | tag | 90 | 0.11 | 0.16 | 0.19 (stats) | yes | 0 |
| conc | 10 | small | 7d | none | 90 | 0.13 | 0.27 | 0.46 (stats) | yes | 0 |
| conc | 10 | small | 7d | tag | 90 | 0.11 | 0.22 | 0.24 (stats) | yes | 0 |
| conc | 10 | small | 30d | none | 90 | 0.19 | 2.19 | 3.28 (stats) | NO | 0 |
| conc | 10 | small | 30d | tag | 90 | 0.19 | 0.42 | 0.57 (stats) | yes | 0 |
| conc | 10 | small | 90d | none | 90 | 0.50 | 0.82 | 0.91 (stats) | yes | 0 |
| conc | 10 | small | 90d | tag | 90 | 0.39 | 0.79 | 0.96 (metrics:country) | yes | 0 |
| cold | 1 | large | 24h | none | 9 | 0.29 | 3.31 | 4.14 (stats) | NO | 0 |
| cold | 1 | large | 24h | tag | 9 | 0.27 | 3.54 | 4.49 (stats) | NO | 0 |
| cold | 1 | large | 7d | none | 9 | 1.74 | 17.71 | 25.03 (stats) | NO | 0 |
| cold | 1 | large | 7d | tag | 9 | 1.57 | 8.53 | 10.03 (stats) | NO | 0 |
| cold | 1 | medium | 24h | none | 9 | 0.06 | 1.48 | 2.18 (stats) | NO | 0 |
| cold | 1 | medium | 24h | tag | 9 | 0.05 | 1.45 | 2.15 (stats) | NO | 0 |
| cold | 1 | medium | 7d | none | 9 | 0.27 | 2.75 | 2.83 (stats) | NO | 0 |
| cold | 1 | medium | 7d | tag | 9 | 0.25 | 2.92 | 3.45 (stats) | NO | 0 |
| cold | 1 | medium | 14d | none | 9 | 0.86 | 6.07 | 6.25 (stats) | NO | 0 |
| cold | 1 | medium | 14d | tag | 9 | 0.47 | 6.77 | 7.15 (stats) | NO | 0 |
| cold | 1 | small | 24h | none | 9 | 0.03 | 0.19 | 0.24 (stats) | yes | 0 |
| cold | 1 | small | 24h | tag | 9 | 0.02 | 0.18 | 0.23 (stats) | yes | 0 |
| cold | 1 | small | 7d | none | 9 | 0.03 | 0.75 | 1.07 (stats) | NO | 0 |
| cold | 1 | small | 7d | tag | 9 | 0.03 | 0.85 | 1.28 (stats) | NO | 0 |
| cold | 1 | small | 30d | none | 9 | 0.06 | 3.04 | 4.52 (stats) | NO | 0 |
| cold | 1 | small | 30d | tag | 9 | 0.07 | 3.36 | 4.94 (stats) | NO | 0 |
| cold | 1 | small | 90d | none | 9 | 0.15 | 1.28 | 1.85 (stats) | yes | 0 |
| cold | 1 | small | 90d | tag | 9 | 0.13 | 4.48 | 6.90 (stats) | NO | 0 |

### Per endpoint p95 (seconds), warm, c=1

| site | range | filter | stats | pageviews | metrics:browser | metrics:country | metrics:device | metrics:event | metrics:os | metrics:path | metrics:referrer |
|---|---|---|---|---|---|---|---|---|---|---|---|
| large | 24h | none | 0.38 | 0.33 | 0.31 | 0.30 | 0.30 | 0.08 | 0.30 | 0.26 | 0.10 |
| large | 24h | tag | 0.52 | 0.18 | 0.27 | 0.28 | 0.29 | 0.08 | 0.28 | 0.14 | 0.10 |
| large | 7d | none | 3.75 | 1.15 | 1.86 | 1.87 | 1.90 | 0.32 | 1.88 | 1.02 | 0.48 |
| large | 7d | tag | 5.01 | 2.20 | 3.06 | 3.31 | 3.04 | 0.70 | 3.08 | 1.73 | 0.97 |
| large | 14d | none | 15.26 | 3.57 | 7.96 | 9.16 | 7.83 | 3.42 | 6.88 | 2.16 | 1.36 |
| large | 14d | tag | 7.50 | 2.51 | 5.22 | 6.12 | 5.89 | 2.82 | 6.55 | 1.79 | 1.03 |
| large | 30d | none | 43.07 | 8.38 | 13.27 | 11.13 | 14.06 | 1.98 | 13.56 | 8.33 | 7.00 |
| large | 30d | tag | 30.91 | 5.31 | 6.93 | 6.13 | 5.94 | 2.22 | 6.06 | 4.27 | 2.66 |
| large | 90d | none | 24.29 | 15.29 | 18.08 | 22.49 | 17.95 | 10.41 | 17.92 | 12.96 | 7.39 |
| large | 90d | tag | 23.51 | 14.87 | 18.79 | 21.25 | 19.60 | 6.61 | 19.92 | 13.44 | 8.09 |
| medium | 24h | none | 0.07 | 0.05 | 0.07 | 0.07 | 0.07 | 0.03 | 0.07 | 0.04 | 0.03 |
| medium | 24h | tag | 0.09 | 0.06 | 0.07 | 0.08 | 0.07 | 0.03 | 0.07 | 0.04 | 0.04 |
| medium | 7d | none | 0.43 | 0.29 | 0.34 | 0.36 | 0.35 | 0.18 | 0.37 | 0.25 | 0.16 |
| medium | 7d | tag | 0.64 | 0.26 | 0.29 | 0.29 | 0.30 | 0.13 | 0.32 | 0.21 | 0.14 |
| medium | 14d | none | 0.83 | 0.54 | 0.73 | 0.73 | 0.72 | 0.24 | 0.72 | 0.51 | 0.29 |
| medium | 14d | tag | 1.63 | 0.46 | 0.54 | 0.54 | 0.53 | 0.27 | 0.56 | 0.44 | 0.25 |
| medium | 30d | none | 10.51 | 2.83 | 9.96 | 3.74 | 4.67 | 1.99 | 5.25 | 1.61 | 1.06 |
| medium | 30d | tag | 5.67 | 1.91 | 4.78 | 1.86 | 1.92 | 0.91 | 2.01 | 1.21 | 0.57 |
| medium | 90d | none | 35.91 | 22.54 | 24.46 | 21.73 | 31.03 | 8.07 | 30.48 | 30.34 | 12.37 |
| medium | 90d | tag | 183.39 | 27.08 | 13.78 | 16.85 | 15.34 | 7.97 | 19.59 | 7.09 | 1.99 |
| small | 24h | none | 0.02 | 0.02 | 0.02 | 0.02 | 0.02 | 0.02 | 0.02 | 0.01 | 0.02 |
| small | 24h | tag | 0.02 | 0.01 | 0.02 | 0.02 | 0.01 | 0.01 | 0.02 | 0.01 | 0.01 |
| small | 7d | none | 0.03 | 0.02 | 0.04 | 0.04 | 0.04 | 0.02 | 0.04 | 0.02 | 0.02 |
| small | 7d | tag | 0.05 | 0.03 | 0.07 | 0.04 | 0.05 | 0.02 | 0.06 | 0.03 | 0.03 |
| small | 14d | none | 0.05 | 0.04 | 0.06 | 0.06 | 0.05 | 0.03 | 0.06 | 0.04 | 0.03 |
| small | 14d | tag | 0.07 | 0.03 | 0.05 | 0.05 | 0.05 | 0.03 | 0.05 | 0.03 | 0.03 |
| small | 30d | none | 0.08 | 0.05 | 0.08 | 0.08 | 0.08 | 0.04 | 0.08 | 0.05 | 0.04 |
| small | 30d | tag | 0.11 | 0.05 | 0.08 | 0.08 | 0.08 | 0.04 | 0.08 | 0.05 | 0.04 |
| small | 90d | none | 0.15 | 0.19 | 0.19 | 0.18 | 0.17 | 0.09 | 0.17 | 0.15 | 0.13 |
| small | 90d | tag | 0.20 | 0.11 | 0.12 | 0.12 | 0.12 | 0.07 | 0.12 | 0.10 | 0.08 |

### Per endpoint (seconds), cold (single load after restart with direct I/O)

| site | range | filter | stats | pageviews | metrics:browser | metrics:country | metrics:device | metrics:event | metrics:os | metrics:path | metrics:referrer |
|---|---|---|---|---|---|---|---|---|---|---|---|
| large | 24h | none | 4.14 | 0.30 | 2.06 | 0.28 | 0.29 | 0.07 | 0.29 | 0.27 | 0.09 |
| large | 24h | tag | 4.49 | 0.16 | 2.11 | 0.27 | 0.28 | 0.08 | 0.27 | 0.13 | 0.08 |
| large | 7d | none | 25.03 | 1.10 | 6.74 | 1.74 | 1.75 | 0.30 | 1.79 | 0.90 | 0.43 |
| large | 7d | tag | 10.03 | 1.06 | 6.30 | 1.57 | 1.57 | 0.34 | 1.91 | 0.79 | 0.46 |
| medium | 24h | none | 2.18 | 0.07 | 0.43 | 0.06 | 0.06 | 0.03 | 0.06 | 0.05 | 0.03 |
| medium | 24h | tag | 2.15 | 0.07 | 0.39 | 0.05 | 0.05 | 0.03 | 0.05 | 0.05 | 0.03 |
| medium | 7d | none | 2.83 | 0.27 | 2.64 | 0.27 | 0.28 | 0.10 | 0.28 | 0.20 | 0.13 |
| medium | 7d | tag | 3.45 | 0.28 | 2.13 | 0.25 | 0.25 | 0.10 | 0.26 | 0.18 | 0.13 |
| medium | 14d | none | 6.25 | 0.63 | 5.79 | 0.86 | 1.00 | 0.28 | 1.00 | 0.57 | 0.44 |
| medium | 14d | tag | 7.15 | 0.50 | 6.21 | 0.47 | 0.46 | 0.20 | 0.49 | 0.42 | 0.27 |
| small | 24h | none | 0.24 | 0.04 | 0.12 | 0.02 | 0.02 | 0.01 | 0.02 | 0.03 | 0.03 |
| small | 24h | tag | 0.23 | 0.03 | 0.10 | 0.02 | 0.02 | 0.01 | 0.02 | 0.03 | 0.02 |
| small | 7d | none | 1.07 | 0.04 | 0.26 | 0.03 | 0.03 | 0.02 | 0.03 | 0.03 | 0.02 |
| small | 7d | tag | 1.28 | 0.04 | 0.21 | 0.03 | 0.03 | 0.02 | 0.03 | 0.03 | 0.02 |
| small | 30d | none | 4.52 | 0.07 | 0.81 | 0.06 | 0.06 | 0.02 | 0.06 | 0.04 | 0.03 |
| small | 30d | tag | 4.94 | 0.07 | 1.00 | 0.08 | 0.10 | 0.04 | 0.07 | 0.06 | 0.04 |
| small | 90d | none | 1.85 | 0.23 | 0.43 | 0.13 | 0.15 | 0.05 | 0.18 | 0.12 | 0.09 |
| small | 90d | tag | 6.90 | 0.17 | 0.86 | 0.13 | 0.20 | 0.05 | 0.13 | 0.09 | 0.06 |
