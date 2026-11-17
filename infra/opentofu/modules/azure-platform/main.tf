# SPDX-License-Identifier: Apache-2.0
# Azure platform module (C-96): the recommended topology of docs/deployment-topology.md mapped onto Azure — four edge
# nodes across availability zones, two core nodes (PostgreSQL primary and synchronous standby, ADR-0020), a
# monitoring/witness node and an external probe in a second EU region, one egress proxy (C-10), two backup storage
# accounts in two EU regions with blob versioning and a previous-version lifecycle rule (C-108, C-110, C-112), private
# endpoints, DNS zones. Hosts are configured afterwards by infra/ansible. Secrets are not created here: they live in
# SOPS (ADR-0019, C-79) and reach hosts through Ansible; no storage account key is ever used (shared keys disabled,
# managed identities with a custom role that cannot delete blob versions).

locals {
  tags = merge({ project = "scf-analytics", managed-by = "opentofu" }, var.tags)

  node_location = { for n, v in var.nodes : n => contains(["mon", "probe"], v.class) ? var.secondary_location : var.location }
  node_rg       = { for n, v in var.nodes : n => contains(["mon", "probe"], v.class) ? azurerm_resource_group.secondary.name : azurerm_resource_group.primary.name }
  # Nodes that write backups (they run PostgreSQL and pgBackRest) and the read-only drill host.
  backup_writers = [for n, v in var.nodes : n if v.postgres]
}

resource "azurerm_resource_group" "primary" {
  name     = "${var.name_prefix}-rg-${var.location}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_resource_group" "secondary" {
  name     = "${var.name_prefix}-rg-${var.secondary_location}"
  location = var.secondary_location
  tags     = local.tags
}
