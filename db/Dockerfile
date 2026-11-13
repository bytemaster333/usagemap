# SPDX-License-Identifier: Apache-2.0
# Two images from one recipe (build context: db/):
#   target `server`  — the PostgreSQL 18.7 server image (Compose service `postgres`, db/tests `pg`)
#                       docker build --target server -t scf-postgres db/
#   default (last)   — one-shot `db-migrate` for database `scf` and the `umami-views` step
#                       docker build -t scf-db-migrate db/
# The migration image is built FROM the server stage, so its psql matches the server exactly, and an image scan of
# the last stage covers both.
#
# Base: postgres:18.7-alpine (Alpine 3.24.4), pinned by index digest (multi-arch). 18.6 carried 58
# HIGH/CRITICAL findings at Trivy 0.76.2 + Grype 0.121.3 (2026-11-13): krb5-libs 1.22.2-r1, libxslt 1.1.43-r3,
# zlib 1.3.2-r1, and gosu built with Go 1.24.6. The server stage
#   - upgrades exactly those three Alpine packages to pinned, fixed versions (APKINDEX signed by the Alpine keys
#     shipped in the base, package checksums verified by apk; an exact pin fails the build instead of drifting), and
#   - removes gosu: the server runs as the postgres user (uid 70) from the start (Compose `user: "70:70"`), so the
#     entrypoint never switches users. Running it as root now fails at the entrypoint's `gosu` call — intended.
# Result: zero fixable HIGH/CRITICAL at both scanners (OpenSSL 3.5.9-r0 has no Alpine fix yet: image exception). When
# upstream rebuilds (≥ 3 days old, supply-chain.md §5), move the digest and drop pins the new base already satisfies.
FROM postgres:18.7-alpine@sha256:b6972e1115a4ff8eba5d7f7d19184926d1e16d7d1136ae1e1a7ebf286da0f015 AS server

LABEL org.opencontainers.image.title="scf-postgres" \
      org.opencontainers.image.description="PostgreSQL 18.7 (Alpine) with patched krb5/libxslt/zlib and without gosu; runs as uid 70" \
      org.opencontainers.image.licenses="PostgreSQL"

RUN apk add --no-cache --upgrade \
        'krb5-libs=1.22.3-r0' \
        'libxslt=1.1.43-r4' \
        'zlib=1.4-r0' \
 && rm -f /usr/local/bin/gosu \
 && rm -rf /var/cache/apk/*

USER 70:70

FROM server AS migrate

LABEL org.opencontainers.image.title="scf-db-migrate" \
      org.opencontainers.image.description="Applies the scf database migrations (ledger + advisory lock) and the umami scf_ro views" \
      org.opencontainers.image.licenses="Apache-2.0"

USER root
ENV SCF_DB_DIR=/db
COPY --chown=root:root --chmod=0444 migrations/ /db/migrations/
COPY --chown=root:root --chmod=0444 bootstrap/ /db/bootstrap/
COPY --chown=root:root --chmod=0444 gates/ /db/gates/
COPY --chown=root:root --chmod=0444 umami/ /db/umami/
COPY --chown=root:root --chmod=0444 definer-allowlist.txt rls-allowlist.txt /db/
COPY --chown=root:root --chmod=0555 migrate.sh /db/migrate.sh
RUN chmod 0555 /db /db/migrations /db/bootstrap /db/gates /db/umami

# The image never runs a server: no data directory, no VOLUME use, unprivileged user (postgres, uid 70).
USER 70:70
WORKDIR /tmp
ENTRYPOINT ["/db/migrate.sh"]
CMD ["migrate"]
