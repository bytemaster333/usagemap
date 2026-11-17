# SPDX-License-Identifier: Apache-2.0
# OpenTofu only (MPL-2.0; ADR-0019) — never Terraform ≥ 1.6 (BUSL). Provider from the OpenTofu registry, pinned exactly;
# the lock file of the root module (envs/v1-small/.terraform.lock.hcl) pins its checksums.
terraform {
  required_version = "~> 1.13"
  required_providers {
    azurerm = {
      source  = "registry.opentofu.org/hashicorp/azurerm" # MPL-2.0
      version = "5.13.0"
    }
  }
}
