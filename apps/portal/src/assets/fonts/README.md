# Portal fonts

The same self-hosted files as `apps/landing/assets/fonts` (see the README there for source and licence: Manrope,
Geist and Geist Mono, latin subsets, OFL-1.1, unmodified Google Fonts files). Vite emits them with a content hash;
the portal's CSP allows `font-src 'self'` only, so nothing loads from another origin.
