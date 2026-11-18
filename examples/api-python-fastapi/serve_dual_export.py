# SPDX-License-Identifier: Apache-2.0
# Dual-export entry point: the providers first, then the app, instrumented in code, served by uvicorn.
import os

import otel_dual_export  # noqa: F401  (sets the providers before anything is instrumented)
import uvicorn
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

from app import app

FastAPIInstrumentor.instrument_app(app)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), log_level="warning")
