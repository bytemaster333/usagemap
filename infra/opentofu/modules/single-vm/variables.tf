# SPDX-License-Identifier: Apache-2.0
# Inputs of the small single-VM shape (one small VM; the HA multi-node design and the full-size lean profile in
# modules/azure-lean are the documented larger production paths).

locals {
  eu_regions = [
    "westeurope", "northeurope", "francecentral", "francesouth", "germanywestcentral", "germanynorth",
    "swedencentral", "swedensouth", "italynorth", "polandcentral", "spaincentral", "norwayeast", "norwaywest",
    "austriaeast", "belgiumcentral", "denmarkeast",
  ]
}

variable "resource_group_name" {
  description = "EXISTING resource group to create everything in (the module creates no resource group: the deploying identity may hold Contributor on one group only)."
  type        = string
}

variable "name_prefix" {
  description = "Prefix of every resource name (2–12 lowercase letters, digits or dashes, starting with a letter)."
  type        = string
  default     = "usagemap"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,11}$", var.name_prefix))
    error_message = "name_prefix must be 2–12 lowercase letters, digits or dashes, starting with a letter."
  }
}

variable "location" {
  description = "EU/EEA region of every resource (ADR-0017)."
  type        = string
  default     = "westeurope"
  validation {
    condition     = contains(local.eu_regions, var.location)
    error_message = "location must be a region inside the EU/EEA (ADR-0017)."
  }
}

variable "address_space" {
  description = "Address space of the virtual network (a /16); the VM subnet is .1.0/24."
  type        = string
  default     = "10.60.0.0/16"
  validation {
    condition     = can(cidrsubnet(var.address_space, 8, 1)) && endswith(var.address_space, "/16")
    error_message = "address_space must be an IPv4 /16."
  }
}

variable "vm" {
  description = <<-EOT
    The one VM running the whole Compose stack (lean profile). Default Standard_D2as_v5 (2 vCPU, 8 GiB) =
    the small shape; os_disk_gb holds Docker's data root and PostgreSQL (no separate data disk in this shape).
  EOT
  type = object({
    name         = optional(string, "usagemap-vm")
    size         = optional(string, "Standard_D2as_v5")
    os_disk_gb   = optional(number, 128)
    os_disk_type = optional(string, "StandardSSD_LRS")
  })
  default = {}
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,31}$", var.vm.name)) && var.vm.os_disk_gb >= 64
    error_message = "vm.name must match ^[a-z0-9][a-z0-9-]{1,31}$ (C-114) and os_disk_gb must be ≥ 64."
  }
}

variable "admin_username" {
  description = "Login of the operators (SSH keys only, no password)."
  type        = string
  default     = "azureuser"
}

variable "admin_ssh_keys" {
  description = "SSH public keys of the operators (per-person keys)."
  type        = list(string)
  validation {
    condition     = length(var.admin_ssh_keys) > 0
    error_message = "At least one SSH public key is required."
  }
}

variable "admin_source_cidrs" {
  description = "Addresses allowed to reach SSH (the operators' addresses). Never 0.0.0.0/0."
  type        = list(string)
  validation {
    condition     = length(var.admin_source_cidrs) > 0 && alltrue([for c in var.admin_source_cidrs : can(cidrnetmask(c)) && !contains(["0.0.0.0/0", "*"], c)])
    error_message = "admin_source_cidrs must be one or more IPv4 CIDRs and never 0.0.0.0/0."
  }
}

variable "public_ports" {
  description = "TCP ports open from the internet on the two front addresses (443 = service, 80 = redirect to https)."
  type        = list(number)
  default     = [80, 443]
}

variable "backup_storage_account" {
  description = "Globally unique name of the backup storage account (3–24 lowercase letters or digits)."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.backup_storage_account))
    error_message = "backup_storage_account must be 3–24 lowercase letters or digits."
  }
}

variable "backup_previous_version_days" {
  description = "Days a previous blob version / soft-deleted blob is kept (C-108/C-110: 14; erasure bound C-112)."
  type        = number
  default     = 14
  validation {
    condition     = var.backup_previous_version_days >= 1 && var.backup_previous_version_days <= 14
    error_message = "Previous versions are kept at most 14 days (C-110/C-112 erasure bound)."
  }
}

variable "backup_access_tier" {
  description = "Access tier of the backup account (Cool for the v1 volume; Hot when WAL churn makes early-deletion charges matter)."
  type        = string
  default     = "Cool"
  validation {
    condition     = contains(["Hot", "Cool"], var.backup_access_tier)
    error_message = "backup_access_tier must be Hot or Cool."
  }
}

variable "image" {
  description = "Debian 13 image pinned to one published version (never `latest`)."
  type = object({
    publisher = optional(string, "Debian")
    offer     = optional(string, "debian-13")
    sku       = optional(string, "13-gen2")
    version   = string
  })
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.image.version))
    error_message = "image.version must be one exact published version (e.g. 0.20261118.2666), never `latest`."
  }
}

variable "encryption_at_host" {
  description = "Encrypt temp disks and caches at the host (needs the EncryptionAtHost feature on the subscription)."
  type        = bool
  default     = false
}

variable "drill_vms" {
  description = <<-EOT
    TEMPORARY drill VMs (rebuild drill, handover drill): name → size. Same subnet, one outbound-only public IP each,
    SSH from admin_source_cidrs only, no inbound web ports. Empty in steady state; remove an entry to delete its VM,
    disk, NIC and IP.
  EOT
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for n in keys(var.drill_vms) : can(regex("^[a-z0-9][a-z0-9-]{1,31}$", n))])
    error_message = "drill VM names must match ^[a-z0-9][a-z0-9-]{1,31}$."
  }
}

variable "tags" {
  description = "Tags added to every resource."
  type        = map(string)
  default     = {}
}
