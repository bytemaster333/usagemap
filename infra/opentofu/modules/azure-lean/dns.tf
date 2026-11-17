# SPDX-License-Identifier: Apache-2.0
# Azure DNS (C-123: one DNS provider, no health controller): the public zones, A records of the ingest host names →
# the ingest address and of the portal (and status) host name → the portal address, a CAA record per zone that admits
# one CA, and the ACME DNS-01 rights of the app VM. Least privilege (lego's documented managed-identity setup): Reader
# on the zone (to find it) and DNS Zone Contributor on each `_acme-challenge.<host>` TXT record set only — the identity
# cannot change any A record or any other name.

locals {
  front_hosts = merge(
    { for h in var.ingest_hostnames : h => "ingest" },
    { (var.portal_hostname) = "portal" },
    var.status_hostname == "" ? {} : { (var.status_hostname) = "portal" },
  )
  # host → { zone, label } where label is the relative name in the zone ("@" for the apex)
  host_zone = { for h, f in local.front_hosts : h => {
    zone  = one([for z in var.dns_zones : z if h == z || endswith(h, ".${z}")])
    front = f
  } }
  host_records = { for h, v in local.host_zone : h => merge(v, {
    label = h == v.zone ? "@" : trimsuffix(h, ".${v.zone}")
  }) }
}

resource "azurerm_dns_zone" "public" {
  for_each            = toset(var.dns_zones)
  name                = each.value
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

resource "azurerm_dns_a_record" "front" {
  for_each            = local.host_records
  name                = each.value.label
  zone_name           = azurerm_dns_zone.public[each.value.zone].name
  resource_group_name = azurerm_resource_group.primary.name
  ttl                 = 300
  records             = [azurerm_public_ip.front[each.value.front].ip_address]
  tags                = local.tags
}

resource "azurerm_dns_caa_record" "zone" {
  for_each            = toset(var.dns_zones)
  name                = "@"
  zone_name           = azurerm_dns_zone.public[each.key].name
  resource_group_name = azurerm_resource_group.primary.name
  ttl                 = 3600
  record {
    flags = 0
    tag   = "issue"
    value = var.acme_ca_domain
  }
  record {
    flags = 0
    tag   = "issuewild"
    value = ";" # no wildcard certificates at all
  }
  tags = local.tags
}

# Placeholder challenge record sets (lego replaces the value during a challenge); they must exist before the role
# assignments that are scoped to them.
resource "azurerm_dns_txt_record" "acme" {
  for_each            = local.host_records
  name                = each.value.label == "@" ? "_acme-challenge" : "_acme-challenge.${each.value.label}"
  zone_name           = azurerm_dns_zone.public[each.value.zone].name
  resource_group_name = azurerm_resource_group.primary.name
  ttl                 = 60
  record {
    value = "scf-acme-placeholder"
  }
  tags = local.tags

  lifecycle {
    ignore_changes = [record] # lego writes the challenge values
  }
}

resource "azurerm_role_assignment" "acme_zone_reader" {
  for_each             = azurerm_dns_zone.public
  scope                = each.value.id
  role_definition_name = "Reader"
  principal_id         = azurerm_linux_virtual_machine.vm["app"].identity[0].principal_id
  description          = "app VM: ACME DNS-01 (lego) finds the zone"
}

resource "azurerm_role_assignment" "acme_txt_contributor" {
  for_each             = azurerm_dns_txt_record.acme
  scope                = each.value.id
  role_definition_name = "DNS Zone Contributor"
  principal_id         = azurerm_linux_virtual_machine.vm["app"].identity[0].principal_id
  description          = "app VM: ACME DNS-01 challenge record of ${each.key} only"
}
