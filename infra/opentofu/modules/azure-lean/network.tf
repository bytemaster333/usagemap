# SPDX-License-Identifier: Apache-2.0
# One virtual network, one subnet for the VM(s), one for the private endpoints of the backup accounts, optionally the
# Bastion subnet. Inbound from the internet: 443 to the two front-end addresses only, and SSH from the operators'
# allow-listed addresses (or Bastion). No database, metrics or admin port is reachable from outside: the database
# and every internal service listen on Docker networks inside the VM only (C-123, threat model).
# Outbound: 80/443 to the internet (ACME, registry, Debian mirrors, Horizon/RPC), 443 to the private endpoints;
# the host firewall (Ansible role `common`) narrows it further per container network.

locals {
  inbound_ssh_sources = var.enable_bastion ? [local.bastion_prefix] : var.admin_source_cidrs
}

resource "azurerm_virtual_network" "main" {
  name                = "${var.name_prefix}-vnet"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
  address_space       = [var.address_space]
  tags                = local.tags
}

resource "azurerm_subnet" "app" {
  name                            = "${var.name_prefix}-snet-app"
  resource_group_name             = azurerm_resource_group.primary.name
  virtual_network_name            = azurerm_virtual_network.main.name
  address_prefixes                = [local.app_prefix]
  default_outbound_access_enabled = false # only the VMs' own public IPs give outbound
}

resource "azurerm_subnet" "endpoints" {
  name                              = "${var.name_prefix}-snet-endpoints"
  resource_group_name               = azurerm_resource_group.primary.name
  virtual_network_name              = azurerm_virtual_network.main.name
  address_prefixes                  = [local.endpoints_prefix]
  default_outbound_access_enabled   = false
  private_endpoint_network_policies = "Enabled" # the NSG applies to the private endpoints too
}

resource "azurerm_subnet" "bastion" {
  count                = var.enable_bastion ? 1 : 0
  name                 = "AzureBastionSubnet" # name required by Azure
  resource_group_name  = azurerm_resource_group.primary.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [local.bastion_prefix]
}

resource "azurerm_network_security_group" "app" {
  name                = "${var.name_prefix}-nsg-app"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

locals {
  app_rules = concat(
    [
      { name = "in-https-front", dir = "Inbound", prio = 100, proto = "Tcp", ports = ["443"], src = ["Internet"], dst = [local.ip_ingest, local.ip_portal] },
      { name = "out-web", dir = "Outbound", prio = 100, proto = "Tcp", ports = ["80", "443"], src = [local.app_prefix], dst = ["Internet"] },
      { name = "out-backup-endpoints", dir = "Outbound", prio = 110, proto = "Tcp", ports = ["443"], src = [local.app_prefix], dst = [local.endpoints_prefix] },
    ],
    length(local.inbound_ssh_sources) > 0 ? [
      { name = "in-ssh-admin", dir = "Inbound", prio = 200, proto = "Tcp", ports = ["22"], src = local.inbound_ssh_sources, dst = [local.app_prefix] },
    ] : [],
    [
      # Explicit denials after the allow rules (Azure's defaults allow all VNet traffic and internet egress).
      { name = "in-deny-vnet", dir = "Inbound", prio = 4000, proto = "*", ports = ["0-65535"], src = ["VirtualNetwork"], dst = ["*"] },
      { name = "in-deny-internet", dir = "Inbound", prio = 4010, proto = "*", ports = ["0-65535"], src = ["Internet"], dst = ["*"] },
      { name = "out-deny-vnet", dir = "Outbound", prio = 4000, proto = "*", ports = ["0-65535"], src = ["*"], dst = ["VirtualNetwork"] },
      { name = "out-deny-internet", dir = "Outbound", prio = 4010, proto = "*", ports = ["0-65535"], src = ["*"], dst = ["Internet"] },
    ],
  )
}

resource "azurerm_network_security_rule" "app" {
  for_each                     = { for r in local.app_rules : r.name => r }
  name                         = each.key
  resource_group_name          = azurerm_resource_group.primary.name
  network_security_group_name  = azurerm_network_security_group.app.name
  priority                     = each.value.prio
  direction                    = each.value.dir
  access                       = startswith(each.key, "in-deny") || startswith(each.key, "out-deny") ? "Deny" : "Allow"
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

# Private endpoints: 443 from the VM subnet only.
resource "azurerm_network_security_group" "endpoints" {
  name                = "${var.name_prefix}-nsg-endpoints"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

resource "azurerm_network_security_rule" "endpoints_in" {
  name                        = "in-backup-from-app"
  resource_group_name         = azurerm_resource_group.primary.name
  network_security_group_name = azurerm_network_security_group.endpoints.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "443"
  source_address_prefix       = local.app_prefix
  destination_address_prefix  = local.endpoints_prefix
}

resource "azurerm_network_security_rule" "endpoints_deny" {
  name                        = "in-deny-all"
  resource_group_name         = azurerm_resource_group.primary.name
  network_security_group_name = azurerm_network_security_group.endpoints.name
  priority                    = 4000
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = "*"
  destination_address_prefix  = "*"
}

resource "azurerm_subnet_network_security_group_association" "endpoints" {
  subnet_id                 = azurerm_subnet.endpoints.id
  network_security_group_id = azurerm_network_security_group.endpoints.id
}

# Optional Azure Bastion (Basic): SSH to private addresses through the Azure portal/CLI, no public SSH at all.
resource "azurerm_public_ip" "bastion" {
  count               = var.enable_bastion ? 1 : 0
  name                = "${var.name_prefix}-pip-bastion"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_bastion_host" "main" {
  count               = var.enable_bastion ? 1 : 0
  name                = "${var.name_prefix}-bastion"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
  sku                 = "Basic"
  tags                = local.tags

  ip_configuration {
    name                 = "bastion"
    subnet_id            = azurerm_subnet.bastion[0].id
    public_ip_address_id = azurerm_public_ip.bastion[0].id
  }
}
