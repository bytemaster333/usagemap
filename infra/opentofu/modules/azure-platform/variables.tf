# SPDX-License-Identifier: Apache-2.0
# Inputs of the Azure platform module (C-96: the deployment target is Azure, EU regions only — ADR-0017).

locals {
  # Azure regions whose data centres are in the EU/EEA (ADR-0017). The provider is US-owned; the data-residency
  # statement says so plainly (C-96). Switzerland and the UK are outside the EU/EEA and are not accepted.
  eu_regions = [
    "westeurope", "northeurope", "francecentral", "francesouth", "germanywestcentral", "germanynorth",
    "swedencentral", "swedensouth", "italynorth", "polandcentral", "spaincentral", "norwayeast", "norwaywest",
    "austriaeast", "belgiumcentral", "denmarkeast",
  ]
  node_classes = ["edge", "core", "db", "mon", "probe", "egress"]
}

variable "name_prefix" {
  description = "Prefix of every resource name (lowercase letters and digits, 2–8 characters)."
  type        = string
  default     = "scf"
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,7}$", var.name_prefix))
    error_message = "name_prefix must be 2–8 lowercase letters or digits, starting with a letter."
  }
}

variable "location" {
  description = "Primary EU region: edge, core, db and egress nodes; backup repository 1."
  type        = string
  default     = "westeurope"
  validation {
    condition     = contains(local.eu_regions, var.location)
    error_message = "location must be an Azure region inside the EU/EEA (ADR-0017)."
  }
}

variable "secondary_location" {
  description = "Second EU region: monitoring and probe nodes (outside the production failure domain) and backup repository 2 (C-110)."
  type        = string
  default     = "swedencentral"
  validation {
    condition     = contains(local.eu_regions, var.secondary_location)
    error_message = "secondary_location must be an Azure region inside the EU/EEA (ADR-0017)."
  }
}

variable "nodes" {
  description = <<-EOT
    Hosts by name (the node name is also the CN of its certificate, C-113; pattern of C-114). class: edge (gateway,
    spool, Collector), core (engine proxy, Umami, control plane, writer, jobs, portal; PostgreSQL in the recommended
    tier), db (dedicated PostgreSQL, hardened tier), mon (monitoring, etcd witness, health controller, restore-drill
    host), probe (external probe only), egress (the egress proxy of C-10). mon and probe nodes are placed in
    secondary_location. data_disk_gb: attached data disk (C-109: ≥ 250 GB wherever PostgreSQL runs).
  EOT
  type = map(object({
    class        = string
    size         = string
    zone         = optional(string)
    data_disk_gb = optional(number, 0)
    postgres     = optional(bool, false)
  }))
  default = {
    "edge-a1"  = { class = "edge", size = "Standard_B2als_v2", zone = "1" }
    "edge-a2"  = { class = "edge", size = "Standard_B2als_v2", zone = "2" }
    "edge-b1"  = { class = "edge", size = "Standard_B2als_v2", zone = "3" }
    "edge-b2"  = { class = "edge", size = "Standard_B2als_v2", zone = "1" }
    "core-a"   = { class = "core", size = "Standard_D4as_v5", zone = "1", data_disk_gb = 256, postgres = true }
    "core-b"   = { class = "core", size = "Standard_D4as_v5", zone = "2", data_disk_gb = 256, postgres = true }
    "mon-c"    = { class = "mon", size = "Standard_B2as_v2", zone = "1", data_disk_gb = 128 }
    "probe-d"  = { class = "probe", size = "Standard_B2ats_v2" }
    "egress-1" = { class = "egress", size = "Standard_B2ats_v2", zone = "3" }
  }
  validation {
    condition     = alltrue([for n, v in var.nodes : can(regex("^[a-z0-9][a-z0-9-]{1,31}$", n))])
    error_message = "Node names must match ^[a-z0-9][a-z0-9-]{1,31}$ (C-114)."
  }
  validation {
    condition     = alltrue([for n, v in var.nodes : contains(local.node_classes, v.class)])
    error_message = "Node class must be one of edge, core, db, mon, probe, egress."
  }
  validation {
    condition     = alltrue([for n, v in var.nodes : !v.postgres || v.data_disk_gb >= 250])
    error_message = "A node that runs PostgreSQL needs a data disk of at least 250 GB (C-109)."
  }
  validation {
    condition     = length([for n, v in var.nodes : n if v.postgres]) == 2
    error_message = "Exactly two nodes run PostgreSQL (primary and synchronous standby, ADR-0020)."
  }
  validation {
    condition     = length([for n, v in var.nodes : n if v.class == "egress"]) >= 1
    error_message = "At least one egress proxy node is required: no other node has internet egress (C-10)."
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
  description = "Addresses allowed to reach SSH (workstations or a bastion). Empty = SSH only over the mesh."
  type        = list(string)
  default     = []
}

variable "address_space" {
  description = "Address spaces of the primary and secondary virtual networks."
  type = object({
    primary   = string
    secondary = string
  })
  default = { primary = "10.40.0.0/16", secondary = "10.41.0.0/16" }
}

variable "backup_storage_accounts" {
  description = "Globally unique names of the two backup storage accounts (3–24 lowercase letters/digits): repo1 in location, repo2 in secondary_location (C-110)."
  type = object({
    repo1 = string
    repo2 = string
  })
  validation {
    condition     = alltrue([for n in values(var.backup_storage_accounts) : can(regex("^[a-z0-9]{3,24}$", n))])
    error_message = "Storage account names are 3–24 lowercase letters or digits."
  }
}

variable "backup_previous_version_days" {
  description = "Days a previous blob version is kept before the lifecycle rule deletes it (C-110: 14). Erased data leaves backups within 35 + 7 + this many days (C-112: 56)."
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

variable "drill_node" {
  description = "Node that runs the weekly restore drill (C-56) and receives read-only access to repository 2 only."
  type        = string
  default     = "mon-c"
}

variable "dns_zones" {
  description = "Public DNS zones hosted in Azure DNS (one of the two providers of C-27; the other is applied by the DNS-as-code tool). Two tracker domains (ADR-0004)."
  type        = list(string)
  default     = []
}

variable "mesh_domain" {
  description = "Private DNS zone for node names and the writers' shared name (`writers.<mesh>` resolves to every core, C-107)."
  type        = string
  default     = "mesh.scf.internal"
}

variable "image" {
  description = "Debian 13 image (ADR-0019), pinned to one published version (F10: never `latest`)."
  type = object({
    publisher = optional(string, "Debian")
    offer     = optional(string, "debian-13")
    sku       = optional(string, "13-gen2")
    version   = string
  })
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.image.version))
    error_message = "image.version must be one exact published version, never `latest`."
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
