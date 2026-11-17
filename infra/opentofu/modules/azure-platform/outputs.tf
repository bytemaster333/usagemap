# SPDX-License-Identifier: Apache-2.0
# Outputs consumed by infra/ansible (inventory) and the runbooks. No secret is output.

output "nodes" {
  description = "Per node: class, region, private and public address, managed identity — the Ansible inventory source."
  value = { for n, v in var.nodes : n => {
    class        = v.class
    postgres     = v.postgres
    location     = local.node_location[n]
    private_ip   = azurerm_network_interface.node[n].private_ip_address
    public_ip    = contains(local.public_ip_classes, v.class) ? azurerm_public_ip.node[n].ip_address : null
    principal_id = azurerm_linux_virtual_machine.node[n].identity[0].principal_id
  } }
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
  description = "Azure DNS name servers per public zone (delegate at the registrar next to the second provider's)."
  value       = { for z, r in azurerm_dns_zone.public : z => r.name_servers }
}

output "backup_writer_forbidden_data_actions" {
  description = "Data actions the database nodes' role does not have (asserted by the tests and the BackupCheckFailing monitor)."
  value       = local.forbidden_data_actions
}
