# SPDX-License-Identifier: Apache-2.0
# Outputs consumed by infra/ansible (scripts/inventory-from-tofu.py --lean) and the runbooks. No secret is output.

output "app" {
  description = "The application VM: name, front-end addresses (public and the private ones Docker publishes on), identity."
  value = {
    name               = var.app_vm.name
    ingest_public_ip   = azurerm_public_ip.front["ingest"].ip_address
    portal_public_ip   = azurerm_public_ip.front["portal"].ip_address
    ingest_private_ip  = local.ip_ingest
    portal_private_ip  = local.ip_portal
    principal_id       = azurerm_linux_virtual_machine.vm["app"].identity[0].principal_id
    tenant_id          = azurerm_linux_virtual_machine.vm["app"].identity[0].tenant_id
    endpoints_prefix   = local.endpoints_prefix
    resource_group     = azurerm_resource_group.primary.name
    dns_resource_group = azurerm_resource_group.primary.name
  }
}

output "standby" {
  description = "The standby VM (null when disabled)."
  value = var.enable_standby ? {
    name         = var.standby_vm.name
    public_ip    = azurerm_public_ip.standby[0].ip_address
    private_ip   = local.ip_standby
    principal_id = azurerm_linux_virtual_machine.vm["standby"].identity[0].principal_id
  } : null
}

output "hostnames" {
  description = "Public host names by front end."
  value = {
    ingest = var.ingest_hostnames
    portal = var.portal_hostname
    status = var.status_hostname
  }
}

output "backup_repositories" {
  description = "pgBackRest repoN-azure-account / -container per repository (key type `auto` = managed identity)."
  value = { for k, r in local.repos : k => {
    account   = azurerm_storage_account.backup[k].name
    container = azurerm_storage_container.pgbackrest[k].name
    location  = r.location
  } }
}

output "dns_name_servers" {
  description = "Azure DNS name servers per zone (delegate at the registrar)."
  value       = { for z, r in azurerm_dns_zone.public : z => r.name_servers }
}

output "backup_writer_forbidden_actions" {
  description = "Actions and data actions the app VM's backup role does not have (asserted by the tests; verify on Azure)."
  value       = concat(local.forbidden_actions, local.forbidden_data_actions)
}
