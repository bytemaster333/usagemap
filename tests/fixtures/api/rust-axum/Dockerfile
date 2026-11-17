# SPDX-License-Identifier: Apache-2.0
# ci-scan: skip test fixture (tests/fixtures/api), never shipped or deployed
# API e2e fixture: the S-06b axum app (copied from spikes/s06b…/apps/rust-axum), TLS build (reqwest-rustls).
FROM rust:1.99.1-slim-trixie@sha256:f6c4a35d21dbb3c89d7a8d056c193e94fc09037f2b58dd858b09c39a47dd02d7 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked --features tls && cp target/release/s06b-rust-axum /app

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /usr/local/bin/app
USER 1000:1000
EXPOSE 8080
CMD ["/usr/local/bin/app"]
