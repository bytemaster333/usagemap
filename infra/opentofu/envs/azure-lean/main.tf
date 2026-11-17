# SPDX-License-Identifier: Apache-2.0
# Root module of the Azure LEAN deployment (C-123: one VM, optional standby, backups in two regions): validated, NOT applied. Run from a
# service-operator workstation only (C-79): CI holds no Azure credentials.
#
#   export TF_VAR_state_passphrase=$(sops -d --extract '["tofu_state_passphrase"]' ../../../secrets/prod.yaml)
#   tofu init -backend-config=backend.hcl && tofu plan -var-file=prod.tfvars -out=lean.tfplan
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
    key              = "scf/azure-lean.tfstate"
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
  description = "Azure subscription (decided at deployment time)."
  type        = string
}

variable "lean" {
  description = "Inputs of modules/azure-lean (see its variables.tf)."
  type        = any
}

provider "azurerm" {
  features {}
  subscription_id                 = var.subscription_id
  storage_use_azuread             = true # shared keys are disabled on the backup accounts
  resource_provider_registrations = "none"
}

module "lean" {
  source                       = "../../modules/azure-lean"
  name_prefix                  = try(var.lean.name_prefix, "scf")
  location                     = try(var.lean.location, "westeurope")
  secondary_location           = try(var.lean.secondary_location, "swedencentral")
  app_vm                       = try(var.lean.app_vm, {})
  enable_standby               = try(var.lean.enable_standby, true)
  standby_vm                   = try(var.lean.standby_vm, {})
  enable_bastion               = try(var.lean.enable_bastion, false)
  admin_ssh_keys               = var.lean.admin_ssh_keys
  admin_source_cidrs           = try(var.lean.admin_source_cidrs, [])
  backup_storage_accounts      = var.lean.backup_storage_accounts
  backup_previous_version_days = try(var.lean.backup_previous_version_days, 14)
  backup_version_immutability  = try(var.lean.backup_version_immutability, false)
  dns_zones                    = var.lean.dns_zones
  ingest_hostnames             = var.lean.ingest_hostnames
  portal_hostname              = var.lean.portal_hostname
  status_hostname              = try(var.lean.status_hostname, "")
  image                        = var.lean.image
}

output "app" { value = module.lean.app }
output "standby" { value = module.lean.standby }
output "hostnames" { value = module.lean.hostnames }
output "backup_repositories" { value = module.lean.backup_repositories }
output "dns_name_servers" { value = module.lean.dns_name_servers }
