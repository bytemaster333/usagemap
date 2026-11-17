# SPDX-License-Identifier: Apache-2.0
# Root module of the v1 small shape: modules/single-vm in an existing resource group plus
# the public DNS records at Cloudflare (DNS only, never proxied: the gateway must see client addresses and terminate
# TLS itself). Run from a service-operator workstation only (C-79); procedure: docs/guides/deploy-v1.md.
#
#   tofu init -backend-config=path=$DEPLOY_DIR/tofu/v1-small.tfstate
#   tofu plan -var-file=$DEPLOY_DIR/tofu/v1.tfvars -out=$DEPLOY_DIR/tofu/v1.tfplan
#
# State and plans: a LOCAL backend outside the repository (0700 directory), encrypted client-side (AES-GCM, key from
# TF_VAR_state_passphrase) — never committed. Credentials: the cloud CLI login for azurerm, CLOUDFLARE_API_TOKEN (a
# token that can edit DNS of this one zone) for cloudflare.
terraform {
  required_version = "~> 1.13"
  required_providers {
    azurerm = {
      source  = "registry.opentofu.org/hashicorp/azurerm" # MPL-2.0
      version = "5.13.0"
    }
    cloudflare = {
      source  = "registry.opentofu.org/cloudflare/cloudflare" # Apache-2.0
      version = "5.29.0"
    }
  }

  backend "local" {}

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
  description = "Passphrase for state and plan encryption (≥ 16 characters). Never in a file in the repository."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.state_passphrase) >= 16
    error_message = "state_passphrase must have at least 16 characters."
  }
}

variable "subscription_id" {
  description = "Subscription that holds the resource group."
  type        = string
}

variable "v1" {
  description = "Inputs of modules/single-vm (see its variables.tf)."
  type        = any
}

variable "dns" {
  description = <<-EOT
    Public names at Cloudflare: zone_id, zone (apex = landing page), portal / status / docs names (portal address) and the
    ingest names (ingest address). CAA allows exactly one CA (lego's default, Let's Encrypt).
  EOT
  type = object({
    zone_id      = string
    zone         = string
    portal       = string
    status       = string
    docs         = optional(string, "") # documentation site (C-152), e.g. docs.<zone>; empty = none
    ingest       = list(string)
    ttl          = optional(number, 300)
    caa_issuer   = optional(string, "letsencrypt.org")
    apex_landing = optional(bool, true)
  })
}

provider "azurerm" {
  features {}
  subscription_id                 = var.subscription_id
  resource_provider_registrations = "none"
}

provider "cloudflare" {} # CLOUDFLARE_API_TOKEN from the environment

module "v1" {
  source                       = "../../modules/single-vm"
  resource_group_name          = var.v1.resource_group_name
  name_prefix                  = try(var.v1.name_prefix, "usagemap")
  location                     = try(var.v1.location, "westeurope")
  vm                           = try(var.v1.vm, {})
  admin_username               = try(var.v1.admin_username, "azureuser")
  admin_ssh_keys               = var.v1.admin_ssh_keys
  admin_source_cidrs           = var.v1.admin_source_cidrs
  public_ports                 = try(var.v1.public_ports, [80, 443])
  backup_storage_account       = var.v1.backup_storage_account
  backup_previous_version_days = try(var.v1.backup_previous_version_days, 14)
  backup_access_tier           = try(var.v1.backup_access_tier, "Cool")
  image                        = var.v1.image
  encryption_at_host           = try(var.v1.encryption_at_host, false)
  drill_vms                    = try(var.v1.drill_vms, {})
  tags                         = try(var.v1.tags, {})
}

locals {
  portal_names = concat(var.dns.apex_landing ? [var.dns.zone] : [], [var.dns.portal, var.dns.status], var.dns.docs != "" ? [var.dns.docs] : [])
  a_records = merge(
    { for n in local.portal_names : n => module.v1.app.portal_public_ip },
    { for n in var.dns.ingest : n => module.v1.app.ingest_public_ip },
  )
}

resource "cloudflare_dns_record" "a" {
  for_each = local.a_records
  zone_id  = var.dns.zone_id
  name     = each.key
  type     = "A"
  content  = each.value
  ttl      = var.dns.ttl
  proxied  = false # DNS only: TLS ends on our VM and the gateway sees the client address
  comment  = "usagemap v1 (opentofu)"
}

resource "cloudflare_dns_record" "caa" {
  zone_id = var.dns.zone_id
  name    = var.dns.zone
  type    = "CAA"
  ttl     = var.dns.ttl
  data = {
    flags = 0
    tag   = "issue"
    value = var.dns.caa_issuer
  }
  comment = "usagemap v1 (opentofu): one CA, no wildcards"
}

output "app" { value = module.v1.app }
output "drill_vms" { value = module.v1.drill_vms }
output "backup" { value = module.v1.backup }
output "hostnames" {
  value = {
    landing = var.dns.apex_landing ? var.dns.zone : ""
    portal  = var.dns.portal
    status  = var.dns.status
    docs    = var.dns.docs
    ingest  = var.dns.ingest
  }
}
