# SPDX-License-Identifier: Apache-2.0
# The tenant's API: one route, plus the flush on shutdown that uvicorn needs (it re-raises SIGTERM, so atexit
# handlers never run and the last export interval would be lost on every restart).
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from opentelemetry import metrics, trace


@asynccontextmanager
async def lifespan(_app):
    yield
    for provider in (trace.get_tracer_provider(), metrics.get_meter_provider()):
        getattr(provider, "shutdown", lambda: None)()


app = FastAPI(lifespan=lifespan)


@app.get("/accounts/{account_id}")
async def account(account_id: str):
    if account_id == "GMISSING":
        return JSONResponse({"error": "account not found"}, status_code=404)
    if account_id == "GBOOM":
        return JSONResponse({"error": "internal"}, status_code=500)
    return {"id": account_id}
