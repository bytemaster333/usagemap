# SPDX-License-Identifier: Apache-2.0
# `tofu test` of the Azure platform module: a full plan against a MOCK azurerm provider (no credentials, no API
# call, nothing applied — C-96: the module is validated during the build, not applied). Asserts the properties the
# design requires of the plan: EU regions, the backup protection model (C-108/C-110/C-112), the egress allow-list
# (C-10), node identity names (C-114), disk sizing (C-109).

mock_provider "azurerm" {
  # Plausible computed values where the module feeds them into other resources' arguments.
  # Resource IDs must have the ARM shape: the provider validates IDs passed as arguments even at plan time.
  mock_resource "azurerm_resource_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test" }
  }
  mock_resource "azurerm_virtual_network" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Network/virtualNetworks/vnet" }
  }
  mock_resource "azurerm_subnet" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Network/virtualNetworks/vnet/subnets/snet" }
  }
  mock_resource "azurerm_network_security_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Network/networkSecurityGroups/nsg" }
  }
  mock_resource "azurerm_private_dns_zone" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Network/privateDnsZones/zone.example" }
  }
  mock_resource "azurerm_storage_account" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Storage/storageAccounts/scftestrepo" }
  }
  mock_resource "azurerm_storage_container" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Storage/storageAccounts/scftestrepo/blobServices/default/containers/pgbackrest" }
  }
  mock_resource "azurerm_managed_disk" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Compute/disks/disk" }
  }
  mock_resource "azurerm_public_ip" {
    defaults = { ip_address = "203.0.113.10", id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Network/publicIPAddresses/pip" }
  }
  mock_resource "azurerm_network_interface" {
    defaults = { private_ip_address = "10.40.2.4", id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Network/networkInterfaces/nic" }
  }
  mock_resource "azurerm_linux_virtual_machine" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Compute/virtualMachines/vm", identity = { principal_id = "11111111-1111-1111-1111-111111111111", tenant_id = "22222222-2222-2222-2222-222222222222" } }
  }
  mock_resource "azurerm_role_definition" {
    defaults = { role_definition_resource_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/33333333-3333-3333-3333-333333333333" }
  }
}

variables {
  admin_ssh_keys          = ["ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDTnWz2xdKf+6rzYlAKlwg1nrdbyC81mVLepmdmLwJ8IR1wmo95UyxSshdhZXkHne0w/MF7Sjpt/Bs0zZTwKM0I/hxL9woDAKTTcs4ZQTxjfpzQtRGFeKpV1ruSZgFrcT7lqsj22vKUPoKDFaE7Xy9eN1W1gv29e6SrrvPjBb/6cAQ7mfNm4dwm9iKvrhhBQUHd6yHLvJ+VjytK9xvMqE/k7YEoDwqENMwNx53137YykzsUYBd3slMgdoeuVyCgIVEZvFEedYAxcaWsDcGOOT5WPvcQHd0gaj9M8+lT2t6JjpZklB7McYj9t6ugcxC+J+uKG6UpDf9Lrs/d/vxjQuZslQluGLjqneRTvfjh0JYZGSjE8cgQ9u1kOImO4gH5cE4A6x4TffB+4EXYC+1/CgQuq8ItDADimLbJEjKarJPfHHxkuz4PAcaEnM/F6qZ4FXPIFZDHzgl7CjcAfW3G0sPVZBlpxbZplFvNu4ZKE6oBcaFUvYbMmygqDzS6C9O7lh8= tofu-test-only"] # throw-away public key, no private key kept
  backup_storage_accounts = { repo1 = "scftestrepo1", repo2 = "scftestrepo2" }
  dns_zones               = ["ingest-one.example", "ingest-two.example"]
  image                   = { version = "0.20261101.2290" }
}

run "plan_recommended_topology" {
  command = plan

  override_resource {
    target = azurerm_network_interface.node["core-b"]
    values = { private_ip_address = "10.40.2.5", id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Network/networkInterfaces/nic-b" }
  }

  # --- regions (ADR-0017, C-110): two different EU regions; repo2 and mon/probe in the second one
  assert {
    condition     = azurerm_storage_account.backup["repo1"].location == "westeurope" && azurerm_storage_account.backup["repo2"].location == "swedencentral"
    error_message = "The two backup repositories must be in two different EU regions."
  }
  assert {
    condition     = azurerm_linux_virtual_machine.node["mon-c"].location == "swedencentral" && azurerm_linux_virtual_machine.node["probe-d"].location == "swedencentral"
    error_message = "Monitoring and probe nodes must sit outside the production region (C-30, C-78)."
  }

  # --- backup protection (C-108, C-110, C-112)
  assert {
    condition     = alltrue([for k, a in azurerm_storage_account.backup : a.blob_properties[0].versioning_enabled])
    error_message = "Blob versioning must be enabled on both backup accounts."
  }
  assert {
    condition     = alltrue([for k, a in azurerm_storage_account.backup : !a.shared_access_key_enabled && a.public_network_access == "Disabled" && a.min_tls_version == "TLS1_2"])
    error_message = "Backup accounts: no shared keys, no public network access, TLS 1.2+."
  }
  assert {
    condition = alltrue([for k, p in azurerm_storage_management_policy.backup :
      p.rule[0].actions[0].version[0].delete_after_days_since_creation == 14 && length(p.rule[0].actions[0].base_blob) == 0
    ])
    error_message = "The lifecycle rule must delete previous versions after 14 days and never act on current blobs."
  }
  assert {
    condition     = length(setintersection(toset(azurerm_role_definition.backup_writer.permissions[0].data_actions), toset(local.forbidden_data_actions))) == 0
    error_message = "The database nodes' role must not be able to delete blob versions or delete permanently."
  }
  assert {
    condition     = length(azurerm_role_assignment.backup_writer) == 4
    error_message = "Each of the two PostgreSQL nodes needs the writer role on each of the two repositories (and nobody else)."
  }
  assert {
    condition     = azurerm_role_assignment.drill_reader.role_definition_name == "Storage Blob Data Reader"
    error_message = "The drill host gets read-only access (C-56, C-108)."
  }

  # --- egress allow-list (C-10): only the egress proxy may reach the internet on 80/443; the probe only our public
  #     endpoints; every class has the explicit internet deny
  assert {
    condition = alltrue([for k, r in azurerm_network_security_rule.allow :
      !(r.direction == "Outbound" && (r.destination_address_prefix == "Internet" || contains(coalesce(r.destination_address_prefixes, []), "Internet"))) || startswith(k, "egress-")
    ])
    error_message = "Only the egress proxy subnet may have an outbound rule to the Internet service tag."
  }
  assert {
    condition     = length(azurerm_network_security_rule.deny_internet_out) == 6 && alltrue([for k, r in azurerm_network_security_rule.deny_internet_out : r.access == "Deny" && r.destination_address_prefix == "Internet"])
    error_message = "Every class subnet needs the explicit internet-egress deny rule."
  }
  assert {
    condition     = alltrue([for s in azurerm_subnet.class : s.default_outbound_access_enabled == false])
    error_message = "Default outbound access must be off on every subnet."
  }

  # --- hosts
  assert {
    condition     = alltrue([for k, d in azurerm_managed_disk.data : d.disk_size_gb >= 250 if contains(["core-a", "core-b"], k)])
    error_message = "PostgreSQL nodes need ≥ 250 GB of data disk (C-109)."
  }
  assert {
    condition     = alltrue([for k, v in azurerm_linux_virtual_machine.node : v.disable_password_authentication && v.secure_boot_enabled && v.computer_name == k])
    error_message = "Hosts: SSH keys only, Trusted Launch, computer name = node name (= certificate CN, C-113)."
  }
  assert {
    condition     = length(azurerm_dns_zone.public) == 2 && length(azurerm_private_dns_a_record.writers.records) == 2
    error_message = "Two public zones (two tracker domains) and `writers` resolving to both cores (C-107)."
  }
}

run "rejects_non_eu_region" {
  command = plan
  variables {
    location = "eastus"
  }
  expect_failures = [var.location]
}

run "rejects_small_database_disk" {
  command = plan
  variables {
    nodes = {
      "core-a"   = { class = "core", size = "Standard_D4as_v5", data_disk_gb = 128, postgres = true }
      "core-b"   = { class = "core", size = "Standard_D4as_v5", data_disk_gb = 256, postgres = true }
      "mon-c"    = { class = "mon", size = "Standard_B2as_v2" }
      "egress-1" = { class = "egress", size = "Standard_B2ats_v2" }
    }
  }
  expect_failures = [var.nodes]
}

run "rejects_bad_node_name" {
  command = plan
  variables {
    nodes = {
      "Core_A"   = { class = "core", size = "Standard_D4as_v5", data_disk_gb = 256, postgres = true }
      "core-b"   = { class = "core", size = "Standard_D4as_v5", data_disk_gb = 256, postgres = true }
      "mon-c"    = { class = "mon", size = "Standard_B2as_v2" }
      "egress-1" = { class = "egress", size = "Standard_B2ats_v2" }
    }
  }
  expect_failures = [var.nodes]
}

run "rejects_latest_image" {
  command = plan
  variables {
    image = { version = "latest" }
  }
  expect_failures = [var.image]
}

run "rejects_long_previous_version_window" {
  command = plan
  variables {
    backup_previous_version_days = 35
  }
  expect_failures = [var.backup_previous_version_days]
}
