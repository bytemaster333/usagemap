# Landing page fonts

Self-hosted so the page loads nothing from another origin (its CSP is `font-src 'self'`). The build
(`apps/landing/build.ts`) writes each file as `assets/fonts/<name>.<sha256 prefix>.woff2` and rewrites the
`url("fonts/<name>")` references in `src/styles.css` to those paths.

| File | Family | Axis | Subset | Licence |
|---|---|---|---|---|
| `manrope-latin.woff2` | Manrope (https://github.com/sharanda/manrope) | weight 200–800 | latin | OFL-1.1 |
| `geist-latin.woff2` | Geist (https://github.com/vercel/geist-font) | weight 100–900 | latin | OFL-1.1 |
| `geist-mono-latin.woff2` | Geist Mono (https://github.com/vercel/geist-font) | weight 100–900 | latin | OFL-1.1 |

The files are the unmodified Google Fonts latin subsets that the approved design loads (fonts.googleapis.com
css2, 2026-11-20), so the built page matches the design pixel for pixel. Characters outside the latin subset fall
back to the system font stack declared next to each family in `src/styles.css`. The documentation site (apps/docs)
self-hosts the same families through `next/font/google` (see `NOTICE`).

To update a font, replace the file with the matching Google Fonts latin subset and rebuild; the hashed name changes
with the content, so caches never serve a stale file.
