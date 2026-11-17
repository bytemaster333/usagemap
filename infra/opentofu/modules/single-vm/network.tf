# SPDX-License-Identifier: Apache-2.0
# One VNet, one subnet (service endpoint for the backup account), one NSG. Inbound: var.public_ports to the two front
# addresses only, SSH from the operators' addresses. Outbound: 80/443 (Debian mirrors, Docker's apt repository, ACME,
# the DNS provider's API, Horizon/RPC), NTP, and the storage service; the host firewall (role common) narrows it
# further per container network.

resource "azurerm_virtual_network" "main" {
  name                = "${var.name_prefix}-vnet"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg.name
  address_space       = [var.address_space]
  tags                = local.tags
}

resource "azurerm_subnet" "app" {
  name                            = "${var.name_prefix}-snet-app"
  resource_group_name             = data.azurerm_resource_group.rg.name
  virtual_network_name            = azurerm_virtual_network.main.name
  address_prefixes                = [local.subnet]
  default_outbound_access_enabled = false # only the VMs' own public IPs give outbound

  service_endpoint {
    service = "Microsoft.Storage"
  }
}

resource "azurerm_network_security_group" "app" {
  name                = "${var.name_prefix}-nsg-app"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg.name
  tags                = local.tags
}

locals {
  nsg_rules = [
    { name = "in-web-front", dir = "Inbound", prio = 100, proto = "Tcp", ports = [for p in var.public_ports : tostring(p)], src = ["Internet"], dst = [local.ip_ingest, local.ip_portal] },
    { name = "in-ssh-admin", dir = "Inbound", prio = 200, proto = "Tcp", ports = ["22"], src = var.admin_source_cidrs, dst = [local.subnet] },
    { name = "in-deny-internet", dir = "Inbound", prio = 4010, proto = "*", ports = ["0-65535"], src = ["Internet"], dst = ["*"] },
    { name = "out-web", dir = "Outbound", prio = 100, proto = "Tcp", ports = ["80", "443"], src = [local.subnet], dst = ["Internet"] },
    { name = "out-storage", dir = "Outbound", prio = 110, proto = "Tcp", ports = ["443"], src = [local.subnet], dst = ["Storage.${var.location}"] },
    { name = "out-ntp", dir = "Outbound", prio = 120, proto = "Udp", ports = ["123"], src = [local.subnet], dst = ["Internet"] },
    { name = "out-deny-internet", dir = "Outbound", prio = 4010, proto = "*", ports = ["0-65535"], src = ["*"], dst = ["Internet"] },
  ]
}

resource "azurerm_network_security_rule" "app" {
  for_each                     = { for r in local.nsg_rules : r.name => r }
  name                         = each.key
  resource_group_name          = data.azurerm_resource_group.rg.name
  network_security_group_name  = azurerm_network_security_group.app.name
  priority                     = each.value.prio
  direction                    = each.value.dir
  access                       = strcontains(each.key, "-deny-") ? "Deny" : "Allow"
  protocol                     = each.value.proto
  source_port_range            = "*"
  destination_port_ranges      = each.value.ports
  source_address_prefix        = length(each.value.src) == 1 ? each.value.src[0] : null
  source_address_prefixes      = length(each.value.src) == 1 ? null : each.value.src
  destination_address_prefix   = length(each.value.dst) == 1 ? each.value.dst[0] : null
  destination_address_prefixes = length(each.value.dst) == 1 ? null : each.value.dst
}

resource "azurerm_subnet_network_security_group_association" "app" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.app.id
}
