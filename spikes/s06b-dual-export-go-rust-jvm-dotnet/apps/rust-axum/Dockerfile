# SPDX-License-Identifier: Apache-2.0
FROM rust:1.99.1-slim-trixie AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# Two binaries: default features (no TLS in the OTLP HTTP client) and --features tls (reqwest-rustls).
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/s06b-rust-axum /s06b-rust-axum && \
    cargo build --release --locked --features tls && cp target/release/s06b-rust-axum /s06b-rust-axum-tls

FROM debian:trixie-slim
# The tls build (reqwest-rustls) cannot even build its HTTP client without a CA bundle (see README).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /s06b-rust-axum /s06b-rust-axum-tls /usr/local/bin/
EXPOSE 8080
CMD ["/usr/local/bin/s06b-rust-axum"]
