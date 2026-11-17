# SPDX-License-Identifier: Apache-2.0
# Inputs of the lean profile (C-123). EU/EEA regions only (ADR-0017); the provider is US-owned and the data-residency
# statement says so (docs/privacy/data-residency.md).

locals {
  eu_regions = [
    "westeurope", "northeurope", "francecentral", "francesouth", "germanywestcentral", "germanynorth",
    "swedencentral", "swedensouth", "italynorth", "polandcentral", "spaincentral", "norwayeast", "norwaywest",
    "austriaeast", "belgiumcentral", "denmarkeast",
  ]
  node_name_re = "^[a-z0-9][a-z0-9-]{1,31}$" # C-114
}

variable "name_prefix" {
  description = "Prefix of every resource name (2–8 lowercase letters or digits, starting with a letter)."
  type        = string
  default     = "scf"
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,7}$", var.name_prefix))
    error_message = "name_prefix must be 2–8 lowercase letters or digits, starting with a letter."
  }
}

variable "location" {
  description = "The one EU region of the lean profile: VMs, network, DNS, backup repository 1."
  type        = string
  default     = "westeurope"
  validation {
    condition     = contains(local.eu_regions, var.location)
    error_message = "location must be an Azure region inside the EU/EEA (ADR-0017)."
  }
}

variable "secondary_location" {
  description = "Second EU region: backup repository 2 only (C-110)."
  type        = string
  default     = "swedencentral"
  validation {
    condition     = contains(local.eu_regions, var.secondary_location)
    error_message = "secondary_location must be an Azure region inside the EU/EEA (ADR-0017)."
  }
}

variable "address_space" {
  description = "Address space of the virtual network (a /16): subnet app = .1.0/24, endpoints = .250.0/24, bastion = .254.0/26."
  type        = string
  default     = "10.50.0.0/16"
  validation {
    condition     = can(cidrsubnet(var.address_space, 8, 250)) && endswith(var.address_space, "/16")
    error_message = "address_space must be an IPv4 /16."
  }
}

variable "app_vm" {
  description = <<-EOT
    The one application VM: the whole Compose stack (gateway, Collector, engine proxy, Umami, control plane, portal,
    writer, jobs, PostgreSQL, PgBouncer, monitoring). Default size Standard_D8as_v5 (8 vCPU, 32 GiB) = the shape of the
    host that sustained 10× the design load (docs/evidence/load, 2026-11-13); Standard_D4as_v5 suits a small start.
    data_disk_gb: PostgreSQL and every Docker volume (C-109: ≥ 250 GB).
  EOT
  type = object({
    name         = optional(string, "app-1")
    size         = optional(string, "Standard_D8as_v5")
    zone         = optional(string, "1")
    data_disk_gb = optional(number, 256)
  })
  default = {}
  validation {
    condition     = can(regex(local.node_name_re, var.app_vm.name)) && var.app_vm.data_disk_gb >= 250
    error_message = "app_vm: name must match ^[a-z0-9][a-z0-9-]{1,31}$ (C-114) and data_disk_gb must be ≥ 250 (C-109)."
  }
}

variable "enable_standby" {
  description = "Create the standby VM: weekly restore drill (repository 2, read only, C-56) and cold-standby target."
  type        = bool
  default     = true
}

variable "standby_vm" {
  description = "Standby VM (no streaming replication: RTO = a restore). Its disk must hold a full restore (C-109)."
  type = object({
    name         = optional(string, "standby-1")
    size         = optional(string, "Standard_D2as_v5")
    zone         = optional(string, "2")
    data_disk_gb = optional(number, 256)
  })
  default = {}
  validation {
    condition     = can(regex(local.node_name_re, var.standby_vm.name)) && var.standby_vm.data_disk_gb >= 250
    error_message = "standby_vm: name must match ^[a-z0-9][a-z0-9-]{1,31}$ and data_disk_gb must be ≥ 250."
  }
}

variable "admin_ssh_keys" {
  description = "SSH public keys of the service operator's team (per-person keys, ADR-0019). No passwords anywhere."
  type        = list(string)
  validation {
    condition     = length(var.admin_ssh_keys) > 0
    error_message = "At least one SSH public key is required."
  }
}

variable "admin_source_cidrs" {
  description = "Addresses allowed to reach SSH (the operators' fixed addresses). Empty = SSH only through Azure Bastion."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for c in var.admin_source_cidrs : can(cidrnetmask(c)) && !contains(["0.0.0.0/0", "*"], c)])
    error_message = "admin_source_cidrs must be IPv4 CIDRs and never 0.0.0.0/0."
  }
}

variable "enable_bastion" {
  description = "Azure Bastion (Basic) in the VNet: SSH without any public SSH exposure."
  type        = bool
  default     = false
}

variable "backup_storage_accounts" {
  description = "Globally unique names of the two backup storage accounts: repo1 in location, repo2 in secondary_location (C-110)."
  type = object({
    repo1 = string
    repo2 = string
  })
  validation {
    condition     = alltrue([for n in values(var.backup_storage_accounts) : can(regex("^[a-z0-9]{3,24}$", n))]) && var.backup_storage_accounts.repo1 != var.backup_storage_accounts.repo2
    error_message = "Two different storage account names of 3–24 lowercase letters or digits."
  }
}

variable "backup_previous_version_days" {
  description = "Days a previous blob version is kept (C-110: 14; erased data leaves backups within 56 days, C-112)."
  type        = number
  default     = 14
  validation {
    condition     = var.backup_previous_version_days >= 1 && var.backup_previous_version_days <= 14
    error_message = "Previous versions are kept at most 14 days (C-110/C-112 erasure bound)."
  }
}

variable "backup_version_immutability" {
  description = "Also lock previous versions with version-level immutability for the same window (optional hardening, S-08)."
  type        = bool
  default     = false
}

variable "dns_zones" {
  description = "Public DNS zones hosted in Azure DNS (the tracker domains, ADR-0004). Delegate them at the registrar."
  type        = list(string)
  validation {
    condition     = length(var.dns_zones) >= 1
    error_message = "At least one DNS zone is required."
  }
}

variable "ingest_hostnames" {
  description = "Ingest host names compiled into the tracker (the gateway's certificate); each inside one of dns_zones."
  type        = list(string)
  validation {
    condition     = length(var.ingest_hostnames) >= 1
    error_message = "At least one ingest host name is required."
  }
  validation {
    condition = alltrue([for h in var.ingest_hostnames :
    length([for z in var.dns_zones : z if h == z || endswith(h, ".${z}")]) == 1])
    error_message = "Every ingest host name must lie in exactly one of dns_zones (its A and ACME records are created there)."
  }
}

variable "portal_hostname" {
  description = "Host name of the portal and the public API (same origin); inside one of dns_zones."
  type        = string
  validation {
    condition     = length([for z in var.dns_zones : z if var.portal_hostname == z || endswith(var.portal_hostname, ".${z}")]) == 1
    error_message = "portal_hostname must lie in exactly one of dns_zones."
  }
}

variable "status_hostname" {
  description = "Optional host name of the status page (served by the portal's Caddy on the portal address). Empty = none."
  type        = string
  default     = ""
}

variable "acme_ca_domain" {
  description = "CAA `issue` value: the only CA allowed to issue for the zones (lego's default CA is Let's Encrypt)."
  type        = string
  default     = "letsencrypt.org"
}

variable "image" {
  description = <<-EOT
    Debian 13 image, pinned to one published version (ADR-0019; F10: never `latest`). List versions with
    `az vm image list --publisher Debian --offer debian-13 --sku 13-gen2 --all -o table` and record the one used.
  EOT
  type = object({
    publisher = optional(string, "Debian")
    offer     = optional(string, "debian-13")
    sku       = optional(string, "13-gen2")
    version   = string
  })
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.image.version))
    error_message = "image.version must be one exact published version (e.g. 0.20261101.2290), never `latest`."
  }
}

variable "encryption_at_host" {
  description = "Encrypt temp disks and caches at the host (needs the EncryptionAtHost feature registered on the subscription)."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags added to every resource."
  type        = map(string)
  default     = {}
}
