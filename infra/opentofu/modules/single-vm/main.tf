# SPDX-License-Identifier: Apache-2.0
# Small single-VM shape: the whole lean-profile Compose stack on ONE small VM inside an existing
# resource group, configured afterwards by infra/ansible (playbooks/lean.yml). What it creates:
#   - one VNet / subnet / NSG: inbound only var.public_ports (80, 443) to the two front addresses, SSH from the
#     operators' addresses; outbound web, NTP and the storage service endpoint, everything else denied
#   - the VM (Debian 13 pinned, Trusted Launch, SSH keys only, no VM extensions) with two front addresses (ingest and
#     portal; Docker publishes the gateway and the portal on them) and one OS disk that also holds the data
#   - one backup storage account (versioning, soft delete, a lifecycle rule deleting previous versions after 14 days,
#     reachable only from the VM subnet's service endpoint and the operators' addresses)
#   - optional temporary drill VMs (rebuild and handover drills)
# Differences from modules/azure-lean (the full-size production profile, unchanged): no resource groups, custom roles,
# role assignments or managed identity (the deploying identity has Contributor on one resource group only), so the
# backup account is written with a container-scoped SAS without the delete-version permission instead; no private
# endpoints (subnet service endpoint instead); one disk; DNS lives at an outside provider (envs/v1-small).
# Secrets are never created here.

locals {
  tags      = merge({ project = "usagemap", managed-by = "opentofu", profile = "v1-small" }, var.tags)
  subnet    = cidrsubnet(var.address_space, 8, 1)
  ip_ingest = cidrhost(local.subnet, 10)
  ip_portal = cidrhost(local.subnet, 11)
  drill_ips = { for i, n in sort(keys(var.drill_vms)) : n => cidrhost(local.subnet, 50 + i) }
}

data "azurerm_resource_group" "rg" {
  name = var.resource_group_name
}
