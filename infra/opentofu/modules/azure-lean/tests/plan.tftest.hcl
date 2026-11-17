# SPDX-License-Identifier: Apache-2.0
# `tofu test` of the lean profile (C-123): a full plan against a MOCK azurerm provider (no credentials, nothing
# applied). Asserts what the profile promises: one EU region plus a second EU region for backup repository 2, inbound
# only 443 to the two front addresses and SSH from the admin range, no database port, the pinned image, the ≥ 250 GB
# data disk, the backup protection model with managed identity only (no SAS, no version deletion), and the ACME
# DNS-01 rights limited to the challenge records.

mock_provider "azurerm" {
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
  mock_resource "azurerm_dns_zone" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Network/dnsZones/zone.example" }
  }
  mock_resource "azurerm_dns_txt_record" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Network/dnsZones/zone.example/TXT/_acme-challenge" }
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
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Network/networkInterfaces/nic" }
  }
  mock_resource "azurerm_linux_virtual_machine" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Compute/virtualMachines/vm", identity = { principal_id = "11111111-1111-1111-1111-111111111111", tenant_id = "22222222-2222-2222-2222-222222222222" } }
  }
  mock_resource "azurerm_role_definition" {
    defaults = { role_definition_resource_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/33333333-3333-3333-3333-333333333333" }
  }
}

variables {
  admin_ssh_keys          = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC4nTOoHjU1vY6xHqoPa4sXfaWAgD2ub9i0ZZMmAJT6i tofu-test-only"] # throw-away public key
  admin_source_cidrs      = ["198.51.100.0/28"]
  backup_storage_accounts = { repo1 = "scftestrepo1", repo2 = "scftestrepo2" }
  dns_zones               = ["ingest-one.example", "ingest-two.example"]
  ingest_hostnames        = ["ingest.ingest-one.example", "ingest.ingest-two.example"]
  portal_hostname         = "app.ingest-one.example"
  status_hostname         = "status.ingest-one.example"
  image                   = { version = "0.20261101.2290" }
}

run "plan_lean_profile" {
  command = plan

  # --- regions: one EU region for everything, repo2 in a second EU region (C-110, C-123)
  assert {
    condition     = alltrue([for k, v in azurerm_linux_virtual_machine.vm : v.location == "westeurope"]) && azurerm_storage_account.backup["repo1"].location == "westeurope" && azurerm_storage_account.backup["repo2"].location == "swedencentral"
    error_message = "VMs and repo1 in the primary region, repo2 in the second EU region."
  }
  assert {
    condition     = length(azurerm_linux_virtual_machine.vm) == 2 && azurerm_linux_virtual_machine.vm["app"].size == "Standard_D8as_v5"
    error_message = "One app VM (D8as_v5 by default) plus the standby VM."
  }

  # --- inbound: 443 to the two front addresses, SSH from the admin range, nothing else; no database/metrics port
  assert {
    condition = alltrue([for k, r in azurerm_network_security_rule.app :
      r.direction != "Inbound" || r.access == "Deny" || k == "in-https-front" || k == "in-ssh-admin"
    ])
    error_message = "Only the HTTPS front rule and the SSH admin rule may allow inbound traffic."
  }
  assert {
    condition     = azurerm_network_security_rule.app["in-https-front"].destination_port_ranges == toset(["443"]) && azurerm_network_security_rule.app["in-https-front"].destination_address_prefixes == toset(["10.50.1.10", "10.50.1.11"])
    error_message = "Inbound HTTPS only on 443 and only to the ingest and portal addresses."
  }
  assert {
    condition     = azurerm_network_security_rule.app["in-ssh-admin"].source_address_prefix == "198.51.100.0/28" && azurerm_network_security_rule.app["in-ssh-admin"].destination_port_ranges == toset(["22"])
    error_message = "SSH only from the allow-listed admin range."
  }
  assert {
    condition = alltrue([for k, r in azurerm_network_security_rule.app :
      length(setintersection(r.destination_port_ranges, toset(["5432", "6432", "2379", "8008", "9090", "3000"]))) == 0
    ])
    error_message = "No database, etcd, Patroni or monitoring port is opened."
  }
  assert {
    condition     = azurerm_subnet.app.default_outbound_access_enabled == false && azurerm_network_security_rule.app["out-deny-internet"].access == "Deny"
    error_message = "No default outbound access; internet egress denied after the 80/443 allow."
  }

  # --- hosts
  assert {
    condition     = alltrue([for k, v in azurerm_linux_virtual_machine.vm : v.source_image_reference[0].version == "0.20261101.2290" && v.disable_password_authentication && v.secure_boot_enabled && v.vtpm_enabled && !v.allow_extension_operations])
    error_message = "Pinned image version, SSH keys only, Trusted Launch, no VM extensions (Run Command)."
  }
  assert {
    condition     = alltrue([for k, d in azurerm_managed_disk.data : d.disk_size_gb >= 250 && d.network_access_policy == "DenyAll"])
    error_message = "Data disks ≥ 250 GB (C-109) and no disk export."
  }
  assert {
    condition     = length(azurerm_network_interface.app.ip_configuration) == 2 && length(azurerm_public_ip.front) == 2
    error_message = "The app VM has two front-end addresses (ingest, portal)."
  }

  # --- backups (C-108, C-110, C-112, F10)
  assert {
    condition     = alltrue([for k, a in azurerm_storage_account.backup : a.blob_properties[0].versioning_enabled && !a.shared_access_key_enabled && a.public_network_access == "Disabled" && a.access_tier == "Hot"])
    error_message = "Backup accounts: versioning, no shared keys, no public network access, hot tier."
  }
  assert {
    condition = alltrue([for k, p in azurerm_storage_management_policy.backup :
      p.rule[0].actions[0].version[0].delete_after_days_since_creation == 14 && length(p.rule[0].actions[0].base_blob) == 0
    ])
    error_message = "Previous versions deleted after 14 days; current blobs never touched by a rule."
  }
  assert {
    condition = (length(setintersection(toset(azurerm_role_definition.backup_writer.permissions[0].data_actions), toset(local.forbidden_data_actions))) == 0
    && length(setintersection(toset(azurerm_role_definition.backup_writer.permissions[0].actions), toset(local.forbidden_actions))) == 0)
    error_message = "The backup role must not delete versions, delete permanently, list keys or create user-delegation keys."
  }
  assert {
    condition     = length(azurerm_role_assignment.backup_writer) == 2 && azurerm_role_assignment.drill_reader[0].role_definition_name == "Storage Blob Data Reader"
    error_message = "The app VM writes both repositories; the standby reads repository 2 only."
  }

  # --- DNS and ACME (C-123)
  assert {
    condition     = length(azurerm_dns_a_record.front) == 4 && azurerm_dns_a_record.front["app.ingest-one.example"].name == "app" && azurerm_dns_a_record.front["ingest.ingest-two.example"].zone_name == "ingest-two.example"
    error_message = "A records for both ingest host names, the portal and the status host, each in its zone."
  }
  assert {
    condition     = length(azurerm_role_assignment.acme_txt_contributor) == 4 && alltrue([for k, r in azurerm_role_assignment.acme_txt_contributor : r.role_definition_name == "DNS Zone Contributor"]) && alltrue([for k, r in azurerm_dns_txt_record.acme : startswith(r.name, "_acme-challenge")])
    error_message = "DNS Zone Contributor only on the _acme-challenge record sets."
  }
  assert {
    condition     = alltrue([for k, r in azurerm_role_assignment.acme_zone_reader : r.role_definition_name == "Reader"])
    error_message = "Zone-level access of the identity is read only."
  }
  assert {
    condition     = alltrue([for k, c in azurerm_dns_caa_record.zone : one([for r in c.record : r.value if r.tag == "issue"]) == "letsencrypt.org"])
    error_message = "CAA admits one CA."
  }
}

run "single_vm_with_bastion" {
  command = plan
  variables {
    enable_standby     = false
    enable_bastion     = true
    admin_source_cidrs = []
  }
  override_resource {
    target = azurerm_subnet.bastion[0]
    values = { id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/scf-rg-test/providers/Microsoft.Network/virtualNetworks/vnet/subnets/AzureBastionSubnet" }
  }
  assert {
    condition     = length(azurerm_linux_virtual_machine.vm) == 1 && length(azurerm_role_assignment.drill_reader) == 0 && length(azurerm_bastion_host.main) == 1
    error_message = "Without the standby: one VM, no drill reader; Bastion created."
  }
  assert {
    condition     = azurerm_network_security_rule.app["in-ssh-admin"].source_address_prefix == "10.50.254.0/26"
    error_message = "With Bastion, SSH is admitted from the Bastion subnet only."
  }
}

run "rejects_latest_image" {
  command = plan
  variables {
    image = { version = "latest" }
  }
  expect_failures = [var.image]
}

run "rejects_non_eu_region" {
  command = plan
  variables {
    secondary_location = "eastus"
  }
  expect_failures = [var.secondary_location]
}

run "rejects_small_data_disk" {
  command = plan
  variables {
    app_vm = { data_disk_gb = 128 }
  }
  expect_failures = [var.app_vm]
}

run "rejects_hostname_outside_zones" {
  command = plan
  variables {
    ingest_hostnames = ["ingest.elsewhere.example"]
  }
  expect_failures = [var.ingest_hostnames]
}

run "rejects_open_ssh" {
  command = plan
  variables {
    admin_source_cidrs = ["0.0.0.0/0"]
  }
  expect_failures = [var.admin_source_cidrs]
}

run "rejects_long_previous_version_window" {
  command = plan
  variables {
    backup_previous_version_days = 35
  }
  expect_failures = [var.backup_previous_version_days]
}
