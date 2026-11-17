# SPDX-License-Identifier: Apache-2.0
# Backup repositories (ADR-0021 as superseded by C-108, C-110, C-112): two storage accounts in two EU regions, each
# with one container `pgbackrest` (pgBackRest repository, WAL archive, weekly logical dumps under dumps/).
#
# Protection model (C-108 replaces C-66): blob versioning is on; database nodes may write and delete CURRENT blobs
# (pgBackRest's own expire keeps the manifest consistent, S-08 O8/O10) but hold no permission to delete versions or
# delete permanently, so a compromised node only turns blobs into previous versions. A lifecycle rule deletes previous
# versions after 14 days and never touches current blobs (erased data leaves backups within 56 days, C-112).
# None of this can be emulated by Azurite (S-08 O9): it is verified on the first real deployment (risk R-23, MP-10).

locals {
  repos = {
    repo1 = { name = var.backup_storage_accounts.repo1, location = var.location, rg = azurerm_resource_group.primary.name }
    repo2 = { name = var.backup_storage_accounts.repo2, location = var.secondary_location, rg = azurerm_resource_group.secondary.name }
  }
  # Data actions of the database nodes' custom role: read, list, write, add, delete current blobs. Deliberately absent:
  # blobs/deleteBlobVersion/action, blobs/permanentDelete/action, immutableStorage/runAsSuperUser/action.
  backup_writer_data_actions = [
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete",
  ]
  forbidden_data_actions = [
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/deleteBlobVersion/action",
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/permanentDelete/action",
    "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/immutableStorage/runAsSuperUser/action",
  ]
  writer_assignments = { for pair in setproduct(keys(local.repos), local.backup_writers) : "${pair[0]}-${pair[1]}" => {
    repo = pair[0], node = pair[1]
  } }
}

resource "azurerm_storage_account" "backup" {
  for_each                 = local.repos
  name                     = each.value.name
  location                 = each.value.location
  resource_group_name      = each.value.rg
  account_kind             = "StorageV2"
  account_tier             = "Standard"
  account_replication_type = "ZRS"
  access_tier              = "Cool"

  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  allow_nested_items_to_be_public  = false
  shared_access_key_enabled        = false # no account key exists to leak; identities and user-delegation SAS only
  default_to_oauth_authentication  = true
  public_network_access            = "Disabled" # private endpoints only
  cross_tenant_replication_enabled = false

  blob_properties {
    versioning_enabled = true
    # Soft delete as a second net for current blobs deleted outside pgBackRest (same 14-day window).
    delete_retention_policy {
      days = var.backup_previous_version_days
    }
    container_delete_retention_policy {
      days = var.backup_previous_version_days
    }
  }

  dynamic "immutability_policy" {
    for_each = var.backup_version_immutability ? [1] : []
    content {
      allow_protected_append_writes = false
      state                         = "Unlocked"
      period_since_creation_in_days = var.backup_previous_version_days
    }
  }

  network_rules {
    default_action = "Deny"
    bypass         = ["None"]
  }

  tags = merge(local.tags, { purpose = "pgbackrest-${each.key}" })

  lifecycle {
    prevent_destroy = true # the backups; removing them is a deliberate, manual decision
  }
}

resource "azurerm_storage_container" "pgbackrest" {
  for_each              = local.repos
  name                  = "pgbackrest"
  storage_account_id    = azurerm_storage_account.backup[each.key].id # management plane: works with public access off
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

# Previous versions are deleted after 14 days; current blobs are never touched by a rule (an age rule on current
# blobs would delete a full backup under a live differential — silent manifest drift, S-08 O10).
resource "azurerm_storage_management_policy" "backup" {
  for_each           = local.repos
  storage_account_id = azurerm_storage_account.backup[each.key].id

  rule {
    name    = "delete-previous-versions"
    enabled = true
    filters {
      blob_types = ["blockBlob"]
    }
    actions {
      version {
        delete_after_days_since_creation = var.backup_previous_version_days
      }
    }
  }
}

resource "azurerm_role_definition" "backup_writer" {
  name        = "${var.name_prefix}-backup-writer"
  scope       = azurerm_resource_group.primary.id
  description = "pgBackRest on database nodes: read, write and delete current blobs; never delete blob versions (C-108)."
  permissions {
    actions = [
      "Microsoft.Storage/storageAccounts/blobServices/containers/read",
      # user-delegation SAS for the weekly logical dump upload (scf-backup dump)
      "Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action",
    ]
    data_actions = local.backup_writer_data_actions
  }
  assignable_scopes = [azurerm_resource_group.primary.id, azurerm_resource_group.secondary.id]
}

resource "azurerm_role_assignment" "backup_writer" {
  for_each           = local.writer_assignments
  scope              = azurerm_storage_container.pgbackrest[each.value.repo].id
  role_definition_id = azurerm_role_definition.backup_writer.role_definition_resource_id
  principal_id       = azurerm_linux_virtual_machine.node[each.value.node].identity[0].principal_id
}

# Restore-drill host (C-56, C-108): read and list on repository 2 only — the equivalent of the `rl` SAS.
resource "azurerm_role_assignment" "drill_reader" {
  scope                = azurerm_storage_container.pgbackrest["repo2"].id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_linux_virtual_machine.node[var.drill_node].identity[0].principal_id
}

# Private endpoints for both accounts in the primary network (the drill host in the secondary network reaches them
# over the peering); name resolution through the private DNS zone linked to both networks.
resource "azurerm_private_dns_zone" "blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "blob" {
  for_each = {
    primary   = azurerm_virtual_network.primary.id
    secondary = azurerm_virtual_network.secondary.id
  }
  name                 = "${var.name_prefix}-blob-${each.key}"
  private_dns_zone_id  = azurerm_private_dns_zone.blob.id
  virtual_network_id   = each.value
  registration_enabled = false
  tags                 = local.tags
}

resource "azurerm_private_endpoint" "backup" {
  for_each            = local.repos
  name                = "${var.name_prefix}-pe-${each.key}"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
  subnet_id           = azurerm_subnet.endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "${var.name_prefix}-psc-${each.key}"
    private_connection_resource_id = azurerm_storage_account.backup[each.key].id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = [azurerm_private_dns_zone.blob.id]
  }
}
