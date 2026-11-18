// SPDX-License-Identifier: Apache-2.0
//! The tenant's API (one route) and the shutdown signal both binaries use.
use axum::{Router, extract::Path, http::StatusCode, routing::get};

pub async fn account(Path(id): Path<String>) -> (StatusCode, String) {
    match id.as_str() {
        "GMISSING" => (StatusCode::NOT_FOUND, r#"{"error":"account not found"}"#.into()),
        "GBOOM" => (StatusCode::INTERNAL_SERVER_ERROR, r#"{"error":"internal"}"#.into()),
        _ => (StatusCode::OK, format!(r#"{{"id":"{id}"}}"#)),
    }
}

pub fn routes() -> Router {
    Router::new().route("/accounts/{id}", get(account))
}

/// SIGTERM (deploys, `docker stop`) or Ctrl-C.
pub async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = term.recv() => {},
        _ = tokio::signal::ctrl_c() => {},
    }
}

pub fn port() -> String {
    std::env::var("PORT").unwrap_or_else(|_| "8080".into())
}
