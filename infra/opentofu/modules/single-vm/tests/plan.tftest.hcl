# SPDX-License-Identifier: Apache-2.0
# `tofu test` of the v1 small shape: a plan against a MOCK azurerm provider (no credentials, nothing applied). Asserts
# what the shape promises: inbound only 80/443 to the two front addresses and SSH from the operator range, the pinned
# image, one disk, the backup account's protection (versioning, 14-day soft delete and previous-version rule, network
# limited to the subnet and the operator, prevent_destroy is in the code), drill VMs that power themselves off.

mock_provider "azurerm" {
  mock_data "azurerm_resource_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test", location = "westeurope" }
  }
  mock_resource "azurerm_subnet" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.Network/virtualNetworks/vnet/subnets/snet" }
  }
  mock_resource "azurerm_network_security_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.Network/networkSecurityGroups/nsg" }
  }
  mock_resource "azurerm_public_ip" {
    defaults = { ip_address = "203.0.113.10", id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.Network/publicIPAddresses/pip" }
  }
  mock_resource "azurerm_network_interface" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.Network/networkInterfaces/nic" }
  }
  mock_resource "azurerm_storage_account" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/providers/Microsoft.Storage/storageAccounts/testbackup", primary_blob_endpoint = "https://testbackup.blob.example/" }
  }
}

variables {
  resource_group_name    = "rg-test"
  admin_ssh_keys         = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC4nTOoHjU1vY6xHqoPa4sXfaWAgD2ub9i0ZZMmAJT6i tofu-test-only"] # throw-away public key
  admin_source_cidrs     = ["198.51.100.7/32"]
  backup_storage_account = "testbackup"
  image                  = { version = "0.20261116.2664" }
}

run "v1_shape" {
  command = plan

  assert {
    condition     = azurerm_linux_virtual_machine.app.size == "Standard_D2as_v5" && azurerm_linux_virtual_machine.app.os_disk[0].disk_size_gb == 128
    error_message = "the v1 VM is Standard_D2as_v5 with a 128 GB OS disk"
  }
  assert {
    condition     = azurerm_linux_virtual_machine.app.source_image_reference[0].version == "0.20261116.2664" && !azurerm_linux_virtual_machine.app.allow_extension_operations
    error_message = "pinned image, no VM extensions"
  }
  assert {
    condition     = toset(azurerm_network_security_rule.app["in-web-front"].destination_port_ranges) == toset(["80", "443"]) && toset(azurerm_network_security_rule.app["in-web-front"].destination_address_prefixes) == toset(["10.60.1.10", "10.60.1.11"])
    error_message = "inbound web only to the two front addresses on 80/443"
  }
  assert {
    condition     = azurerm_network_security_rule.app["in-ssh-admin"].source_address_prefix == "198.51.100.7/32" && toset(azurerm_network_security_rule.app["in-ssh-admin"].destination_port_ranges) == toset(["22"])
    error_message = "SSH only from the operator range"
  }
  assert {
    condition     = length([for k, r in azurerm_network_security_rule.app : k if r.direction == "Inbound" && r.access == "Allow" && contains(r.destination_port_ranges, "5432")]) == 0
    error_message = "no database port reachable"
  }
  assert {
    condition     = azurerm_storage_account.backup.blob_properties[0].versioning_enabled && azurerm_storage_account.backup.blob_properties[0].delete_retention_policy[0].days == 14
    error_message = "backup account: versioning and 14-day soft delete"
  }
  assert {
    condition     = azurerm_storage_account.backup.network_rules[0].default_action == "Deny" && toset(azurerm_storage_account.backup.network_rules[0].ip_rules) == toset(["198.51.100.7"])
    error_message = "backup account: deny by default, the operator address only (plus the subnet)"
  }
  assert {
    condition     = azurerm_storage_management_policy.backup.rule[0].actions[0].version[0].delete_after_days_since_creation == 14
    error_message = "previous versions deleted after 14 days"
  }
  assert {
    condition     = length(azurerm_linux_virtual_machine.drill) == 0
    error_message = "no drill VM by default"
  }
}

run "drill_vm" {
  command = plan
  variables {
    drill_vms = { "drill-x" = "Standard_D2as_v5" }
  }
  assert {
    condition     = strcontains(base64decode(azurerm_linux_virtual_machine.drill["drill-x"].custom_data), "+240")
    error_message = "a drill VM powers itself off after 4 hours"
  }
  assert {
    condition     = !strcontains(base64decode(azurerm_linux_virtual_machine.app.custom_data), "shutdown")
    error_message = "the production VM has no shutdown guard"
  }
}

run "rejects_open_ssh" {
  command = plan
  variables {
    admin_source_cidrs = ["0.0.0.0/0"]
  }
  expect_failures = [var.admin_source_cidrs]
}

run "rejects_non_eu_region" {
  command = plan
  variables {
    location = "eastus2"
  }
  expect_failures = [var.location]
}
