# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# SPDX-License-Identifier: Apache-2.0
# ci-scan: skip operator/test tooling image, never deployed; its tools are GPL-3.0 (Ansible) and run separately
# Workstation/CI tool image for infra/ansible (ADR-0019: ansible-core 2.22): ansible-core, ansible-lint, the
# collections of requirements.yml, openssl and the PostgreSQL client used by the role tests. Never deployed.
FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
RUN set -eux; apt-get update; apt-get install -y --no-install-recommends openssl postgresql-client git openssh-client; \
    rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir ansible-core==2.22.0 ansible-lint==26.11.0
COPY requirements.yml /tmp/requirements.yml
RUN ansible-galaxy collection install -r /tmp/requirements.yml -p /usr/share/ansible/collections
RUN useradd -m -u 1000 ansible
USER ansible
WORKDIR /work
