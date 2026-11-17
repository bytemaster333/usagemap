# SPDX-License-Identifier: Apache-2.0
# Backup repositories (C-108, C-110, C-112; F10): two storage accounts in two EU regions, one container `pgbackrest`
# each (pgBackRest repository, WAL archive, weekly logical dumps under dumps/). The app VM writes both with its managed
# identity — pgBackRest `repoN-azure-key-type=auto`, the weekly dump with a bearer token from the instance metadata
# service — so no account key, SAS or user-delegation key exists (the 7-day user-delegation SAS limit no longer applies).
#
# Protection model: versioning on; the identity may write and delete CURRENT blobs (pgBackRest's own expire) but holds
# no permission to delete versions or delete permanently, so a compromised VM only turns blobs into previous versions,
# which a lifecycle rule deletes after 14 days (erased data leaves backups within 56 days, C-112). Verified only on
# the first real deployment (Azurite cannot emulate it, S-08 O9; risk R-23).

locals {
  repos = {
    repo1 = { name = var.backup_storage_accounts.repo1, location = var.location, rg = azurerm_resource_group.primary.name }
    repo2 = { name = var.backup_storage_accounts.repo2, location = var.secondary_location, rg = azurerm_resource_group.secondary.name }
  }
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
  forbidden_actions = [
    "Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action", # no SAS path (F10)
    "Microsoft.Storage/storageAccounts/listKeys/action",
  ]
}

resource "azurerm_storage_account" "backup" {
  for_each                 = local.repos
  name                     = each.value.name
  location                 = each.value.location
  resource_group_name      = each.value.rg
  account_kind             = "StorageV2"
  account_tier             = "Standard"
  account_replication_type = "ZRS"
  # Hot: WAL segments are written and read back often, and the cool tier's 30-day early-deletion charge would apply
  # to every version the 14-day rule deletes.
  access_tier = "Hot"

  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  allow_nested_items_to_be_public  = false
  shared_access_key_enabled        = false # no account key exists to leak; Entra ID (managed identity) only
  default_to_oauth_authentication  = true
  public_network_access            = "Disabled" # private endpoints only
  cross_tenant_replication_enabled = false

  blob_properties {
    versioning_enabled = true
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
  storage_account_id    = azurerm_storage_account.backup[each.key].id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

# Previous versions are deleted after 14 days; current blobs are never touched by a rule (S-08 O10).
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
  name        = "${var.name_prefix}-lean-backup-writer"
  scope       = azurerm_resource_group.primary.id
  description = "pgBackRest and the weekly dump on the app VM: read, write and delete current blobs; never delete blob versions, never list keys, no user-delegation SAS (C-108, F10)."
  permissions {
    actions      = ["Microsoft.Storage/storageAccounts/blobServices/containers/read"]
    data_actions = local.backup_writer_data_actions
  }
  assignable_scopes = [azurerm_resource_group.primary.id, azurerm_resource_group.secondary.id]
}

resource "azurerm_role_assignment" "backup_writer" {
  for_each           = local.repos
  scope              = azurerm_storage_container.pgbackrest[each.key].id
  role_definition_id = azurerm_role_definition.backup_writer.role_definition_resource_id
  principal_id       = azurerm_linux_virtual_machine.vm["app"].identity[0].principal_id
  description        = "app VM: pgBackRest + weekly dump (managed identity)"
}

# Restore-drill host (C-56, C-108): read and list on repository 2 only.
resource "azurerm_role_assignment" "drill_reader" {
  count                = var.enable_standby ? 1 : 0
  scope                = azurerm_storage_container.pgbackrest["repo2"].id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_linux_virtual_machine.vm["standby"].identity[0].principal_id
  description          = "standby VM: weekly restore drill, read only"
}

resource "azurerm_private_dns_zone" "blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "blob" {
  name                 = "${var.name_prefix}-blob"
  private_dns_zone_id  = azurerm_private_dns_zone.blob.id
  virtual_network_id   = azurerm_virtual_network.main.id
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
