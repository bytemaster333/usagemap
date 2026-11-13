# SPDX-License-Identifier: Apache-2.0
# Helper for S-08: create Azurite containers, mint SAS tokens, list/delete blobs (lifecycle simulation).
FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
RUN pip install --no-cache-dir azure-storage-blob==12.31.1
COPY az.py /usr/local/bin/az.py
ENTRYPOINT ["python", "-I", "/usr/local/bin/az.py"]
