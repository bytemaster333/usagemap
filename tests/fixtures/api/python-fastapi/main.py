"""In-SDK entry point: python main.py  (OTEL_SEMCONV_STABILITY_OPT_IN=http recommended)."""
import os

import otel_setup  # noqa: F401  (providers first)
import uvicorn
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

from app import app

FastAPIInstrumentor.instrument_app(app)

if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "18542")), log_level="warning")
