# SPDX-License-Identifier: Apache-2.0
# ci-scan: skip test fixture (tests/fixtures/api), never shipped or deployed
# API e2e fixture: the S-06a FastAPI app with in-SDK dual export (copied from spikes/s06a…/apps/fastapi).
FROM python:3.13-alpine3.23@sha256:bf88c40985006a79ca25458159a4da1dffc457f9ae234e948b2d6df56ca5ebd2
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py main.py otel_setup.py ./
USER 1000:1000
ENV HOST=0.0.0.0 PORT=8080 OTEL_SEMCONV_STABILITY_OPT_IN=http
EXPOSE 8080
CMD ["python", "main.py"]
