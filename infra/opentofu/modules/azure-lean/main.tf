# SPDX-License-Identifier: Apache-2.0
# Azure lean profile (C-123): the Docker Compose stack on ONE VM in one EU region, an optional standby VM (restore-drill
# host and cold-standby target, not a streaming replica), Azure Blob backups in two storage accounts in two EU regions
# (C-108, C-110, C-112), Azure DNS with ACME DNS-01 rights scoped to the `_acme-challenge` records. Hosts are
# configured afterwards by infra/ansible (playbooks/lean.yml). Secrets are not created here: they live in SOPS
# (ADR-0019, C-79). The multi-node layout (modules/azure-platform) stays the documented scale-out path.

locals {
  tags = merge({ project = "scf-analytics", managed-by = "opentofu", profile = "lean" }, var.tags)

  app_prefix       = cidrsubnet(var.address_space, 8, 1)
  endpoints_prefix = cidrsubnet(var.address_space, 8, 250)
  bastion_prefix   = cidrsubnet(var.address_space, 10, 1016) # x.y.254.0/26

  # Fixed private addresses: Docker publishes the gateway and the portal on these (one public IP each, 1:1 NAT keeps
  # the client address, which the gateway's anti-inflation rules need).
  ip_ingest  = cidrhost(local.app_prefix, 10)
  ip_portal  = cidrhost(local.app_prefix, 11)
  ip_standby = cidrhost(local.app_prefix, 20)

  vms = merge(
    { app = { name = var.app_vm.name, size = var.app_vm.size, zone = var.app_vm.zone, disk_gb = var.app_vm.data_disk_gb } },
    var.enable_standby ? { standby = { name = var.standby_vm.name, size = var.standby_vm.size, zone = var.standby_vm.zone, disk_gb = var.standby_vm.data_disk_gb } } : {},
  )
}

resource "azurerm_resource_group" "primary" {
  name     = "${var.name_prefix}-rg-${var.location}"
  location = var.location
  tags     = local.tags
}

# Holds only backup repository 2 (C-110: two regions).
resource "azurerm_resource_group" "secondary" {
  name     = "${var.name_prefix}-rg-${var.secondary_location}"
  location = var.secondary_location
  tags     = local.tags
}
