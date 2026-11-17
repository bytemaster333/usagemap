# SPDX-License-Identifier: Apache-2.0
# Root module of the Azure deployment (C-96): written and validated during the build, NOT applied. Run from a
# service-operator workstation only (C-79): CI holds no Azure credentials.
#
#   export TF_VAR_state_passphrase=$(sops -d --extract '["tofu_state_passphrase"]' ../../../secrets/prod.yaml)
#   tofu init -backend-config=backend.hcl && tofu plan -var-file=prod.tfvars
terraform {
  required_version = "~> 1.13"
  required_providers {
    azurerm = {
      source  = "registry.opentofu.org/hashicorp/azurerm"
      version = "5.13.0"
    }
  }

  # State in an Azure blob (blob-lease locking), values in backend.hcl (not committed). The state and every plan file
  # are encrypted client-side (ADR-0019): AES-GCM with a key derived from a SOPS-held passphrase.
  backend "azurerm" {
    use_azuread_auth = true
    key              = "scf/azure-eu.tfstate"
  }

  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

variable "state_passphrase" {
  description = "Passphrase for state and plan encryption (SOPS; ≥ 16 characters). Never in a file in the repository."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.state_passphrase) >= 16
    error_message = "state_passphrase must have at least 16 characters."
  }
}

variable "subscription_id" {
  description = "Azure subscription (decided at deployment time, Q-list)."
  type        = string
}

variable "platform" {
  description = "Inputs of modules/azure-platform (see its variables.tf)."
  type        = any
}

provider "azurerm" {
  features {}
  subscription_id                 = var.subscription_id
  storage_use_azuread             = true # shared keys are disabled on the backup accounts
  resource_provider_registrations = "none"
}

module "platform" {
  source                       = "../../modules/azure-platform"
  name_prefix                  = try(var.platform.name_prefix, "scf")
  location                     = try(var.platform.location, "westeurope")
  secondary_location           = try(var.platform.secondary_location, "swedencentral")
  admin_ssh_keys               = var.platform.admin_ssh_keys
  admin_source_cidrs           = try(var.platform.admin_source_cidrs, [])
  backup_storage_accounts      = var.platform.backup_storage_accounts
  dns_zones                    = try(var.platform.dns_zones, [])
  backup_version_immutability  = try(var.platform.backup_version_immutability, false)
  backup_previous_version_days = try(var.platform.backup_previous_version_days, 14)
  image                        = var.platform.image
}

output "nodes" { value = module.platform.nodes }
output "backup_repositories" { value = module.platform.backup_repositories }
output "dns_name_servers" { value = module.platform.dns_name_servers }
