# SPDX-License-Identifier: Apache-2.0
# DNS (C-27): the public zones in Azure DNS — one of the two providers; the static records are applied to both from
# git by the DNS-as-code tool, and the health controller owns only the ingest and portal A/AAAA sets (C-92), so no
# service record is created here. The private mesh zone gives every node a name and `writers` resolves to all
# writer nodes (the Collector's one export name, C-107).

resource "azurerm_dns_zone" "public" {
  for_each            = toset(var.dns_zones)
  name                = each.value
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone" "mesh" {
  name                = var.mesh_domain
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "mesh" {
  for_each = {
    primary   = azurerm_virtual_network.primary.id
    secondary = azurerm_virtual_network.secondary.id
  }
  name                 = "${var.name_prefix}-mesh-${each.key}"
  private_dns_zone_id  = azurerm_private_dns_zone.mesh.id
  virtual_network_id   = each.value
  registration_enabled = false
  tags                 = local.tags
}

resource "azurerm_private_dns_a_record" "node" {
  for_each            = { for n, v in var.nodes : n => v if v.class != "probe" }
  name                = each.key
  private_dns_zone_id = azurerm_private_dns_zone.mesh.id
  ttl                 = 60
  records             = [azurerm_network_interface.node[each.key].private_ip_address]
  tags                = local.tags
}

resource "azurerm_private_dns_a_record" "writers" {
  name                = "writers"
  private_dns_zone_id = azurerm_private_dns_zone.mesh.id
  ttl                 = 60
  records             = [for n, v in var.nodes : azurerm_network_interface.node[n].private_ip_address if v.class == "core"]
  tags                = local.tags
}
