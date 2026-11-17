"""Sample API (FastAPI). Routes: /health, /accounts/{account_id} (404 for GMISSING), /assets/{code}/{issuer}, /boom (500)."""
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from opentelemetry import metrics, trace


@asynccontextmanager
async def lifespan(_app):
    yield
    # uvicorn >= 0.29 re-raises SIGTERM/SIGINT after its graceful shutdown, so the SDK's atexit
    # hook never runs and the last export interval would be lost. Flush explicitly.
    for provider in (trace.get_tracer_provider(), metrics.get_meter_provider()):
        getattr(provider, "shutdown", lambda: None)()


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/accounts/{account_id}")
def account(account_id: str):
    if account_id == "GMISSING":
        raise HTTPException(status_code=404, detail="account not found")
    return {"id": account_id, "balance": "100.0000000"}


@app.get("/assets/{code}/{issuer}")
def asset(code: str, issuer: str):
    return {"code": code, "issuer": issuer}


@app.get("/boom")
def boom():
    raise RuntimeError("boom")
