# SPDX-License-Identifier: Apache-2.0
# Networks, subnets per node class, and NSGs that implement the egress allow-list at the network layer (C-10):
# only the egress proxy (and the probe, towards our own public endpoints only) may reach the internet. The proxy's
# per-destination allow-list (FQDNs per source class) is configured by Ansible (role egress_proxy).

locals {
  primary_classes   = ["edge", "core", "db", "egress"]
  secondary_classes = ["mon", "probe"]

  # One /24 per class, plus one for private endpoints in each network.
  subnet_index = { edge = 1, core = 2, db = 3, egress = 4, mon = 1, probe = 2 }
  subnets = merge(
    { for c in local.primary_classes : c => {
      vnet   = "primary"
      prefix = cidrsubnet(var.address_space.primary, 8, local.subnet_index[c])
    } },
    { for c in local.secondary_classes : c => {
      vnet   = "secondary"
      prefix = cidrsubnet(var.address_space.secondary, 8, local.subnet_index[c])
    } },
  )
  endpoints_prefix = cidrsubnet(var.address_space.primary, 8, 250)
  p                = local.subnets

  # Inbound/outbound allow rules per class. Everything else: inbound denied by Azure's defaults for the internet,
  # VNet-internal traffic restricted by the explicit DenyVnet rules below, internet egress denied (priority 4000).
  # Ports: 443 public (gateway, Caddy), 8443 engine proxy (mTLS, C-60), 4319 writer OTLP (mTLS, C-107), 9443 gateway
  # key exchange (C-04), 51820/udp WireGuard mesh, 5432 PostgreSQL, 8008 Patroni REST, 2379-2380 etcd, 9100/9464
  # metrics scraped by mon, 3128 egress proxy, 22 SSH.
  rules = {
    edge = {
      inbound = [
        { name = "https-internet", port = "443", proto = "Tcp", src = ["Internet"] },
        { name = "keyx-edges", port = "9443", proto = "Tcp", src = [local.p.edge.prefix] },
        { name = "wireguard", port = "51820", proto = "Udp", src = [var.address_space.primary, var.address_space.secondary] },
        { name = "metrics-mon", port = "9100-9464", proto = "Tcp", src = [local.p.mon.prefix] },
      ]
      outbound = [
        { name = "engine-proxy-writer", port = "8443,4319", proto = "Tcp", dst = [local.p.core.prefix] },
        { name = "keyx-edges", port = "9443", proto = "Tcp", dst = [local.p.edge.prefix] },
        { name = "wireguard", port = "51820", proto = "Udp", dst = [var.address_space.primary, var.address_space.secondary] },
        { name = "egress-proxy", port = "3128", proto = "Tcp", dst = [local.p.egress.prefix] },
      ]
    }
    core = {
      inbound = [
        { name = "https-internet", port = "443", proto = "Tcp", src = ["Internet"] },
        { name = "engine-proxy-writer", port = "8443,4319", proto = "Tcp", src = [local.p.edge.prefix, local.p.core.prefix] },
        { name = "postgres-patroni", port = "5432,8008", proto = "Tcp", src = [local.p.core.prefix, local.p.db.prefix] },
        { name = "etcd", port = "2379-2380", proto = "Tcp", src = [local.p.core.prefix, local.p.db.prefix, local.p.mon.prefix] },
        { name = "wireguard", port = "51820", proto = "Udp", src = [var.address_space.primary, var.address_space.secondary] },
        { name = "metrics-mon", port = "8008,9100-9464", proto = "Tcp", src = [local.p.mon.prefix] },
      ]
      outbound = [
        { name = "engine-proxy-writer", port = "8443,4319", proto = "Tcp", dst = [local.p.core.prefix] },
        { name = "postgres-patroni", port = "5432,8008", proto = "Tcp", dst = [local.p.core.prefix, local.p.db.prefix] },
        { name = "etcd", port = "2379-2380", proto = "Tcp", dst = [local.p.core.prefix, local.p.db.prefix, local.p.mon.prefix] },
        { name = "wireguard", port = "51820", proto = "Udp", dst = [var.address_space.primary, var.address_space.secondary] },
        { name = "backup-endpoints", port = "443", proto = "Tcp", dst = [local.endpoints_prefix] },
        { name = "egress-proxy", port = "3128", proto = "Tcp", dst = [local.p.egress.prefix] },
      ]
    }
    db = {
      inbound = [
        { name = "postgres-patroni", port = "5432,8008", proto = "Tcp", src = [local.p.core.prefix, local.p.db.prefix] },
        { name = "etcd", port = "2379-2380", proto = "Tcp", src = [local.p.core.prefix, local.p.db.prefix, local.p.mon.prefix] },
        { name = "wireguard", port = "51820", proto = "Udp", src = [var.address_space.primary, var.address_space.secondary] },
        { name = "metrics-mon", port = "8008,9100-9464", proto = "Tcp", src = [local.p.mon.prefix] },
      ]
      outbound = [
        { name = "postgres-patroni", port = "5432,8008", proto = "Tcp", dst = [local.p.core.prefix, local.p.db.prefix] },
        { name = "etcd", port = "2379-2380", proto = "Tcp", dst = [local.p.core.prefix, local.p.db.prefix, local.p.mon.prefix] },
        { name = "wireguard", port = "51820", proto = "Udp", dst = [var.address_space.primary, var.address_space.secondary] },
        { name = "backup-endpoints", port = "443", proto = "Tcp", dst = [local.endpoints_prefix] },
        { name = "egress-proxy", port = "3128", proto = "Tcp", dst = [local.p.egress.prefix] },
      ]
    }
    egress = {
      inbound = [
        { name = "proxy-clients", port = "3128", proto = "Tcp", src = [var.address_space.primary, var.address_space.secondary] },
        { name = "metrics-mon", port = "9100-9464", proto = "Tcp", src = [local.p.mon.prefix] },
      ]
      outbound = [
        # The only general internet egress (C-10); the proxy allows named destinations per source only.
        { name = "internet-web", port = "80,443", proto = "Tcp", dst = ["Internet"] },
      ]
    }
    mon = {
      inbound = [
        { name = "status-internet", port = "443", proto = "Tcp", src = ["Internet"] },
        { name = "etcd", port = "2379-2380", proto = "Tcp", src = [local.p.core.prefix, local.p.db.prefix] },
        { name = "wireguard", port = "51820", proto = "Udp", src = [var.address_space.primary, var.address_space.secondary] },
      ]
      outbound = [
        { name = "scrape-probe", port = "443,8008,8443,9100-9464", proto = "Tcp", dst = [var.address_space.primary] },
        { name = "etcd", port = "2379-2380", proto = "Tcp", dst = [local.p.core.prefix, local.p.db.prefix] },
        { name = "wireguard", port = "51820", proto = "Udp", dst = [var.address_space.primary, var.address_space.secondary] },
        { name = "backup-endpoints", port = "443", proto = "Tcp", dst = [local.endpoints_prefix] },
        { name = "egress-proxy", port = "3128", proto = "Tcp", dst = [local.p.egress.prefix] },
      ]
    }
    probe = {
      # Outside the monitored failure domain (C-30, C-78): no mesh, no etcd, nothing private. It reaches the public
      # addresses of the edge and core nodes only, and its OS mirrors through the egress proxy.
      inbound = []
      outbound = [
        { name = "probe-public-endpoints", port = "443", proto = "Tcp", dst = local.probe_targets },
        { name = "egress-proxy", port = "3128", proto = "Tcp", dst = [local.p.egress.prefix] },
      ]
    }
  }

  probe_targets = [for n, v in var.nodes : azurerm_public_ip.node[n].ip_address if contains(["edge", "core"], v.class)]

  rule_list = flatten([
    for c, r in local.rules : concat(
      [for i, x in r.inbound : {
        key   = "${c}-in-${x.name}", class = c, direction = "Inbound", priority = 100 + i * 10,
        ports = split(",", x.port), proto = x.proto, src = x.src, dst = [local.subnets[c].prefix]
      }],
      [for i, x in r.outbound : {
        key   = "${c}-out-${x.name}", class = c, direction = "Outbound", priority = 100 + i * 10,
        ports = split(",", x.port), proto = x.proto, src = [local.subnets[c].prefix], dst = x.dst
      }],
    )
  ])

  admin_rule_classes = length(var.admin_source_cidrs) > 0 ? local.node_classes : []
}

resource "azurerm_virtual_network" "primary" {
  name                = "${var.name_prefix}-vnet-primary"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
  address_space       = [var.address_space.primary]
  tags                = local.tags
}

resource "azurerm_virtual_network" "secondary" {
  name                = "${var.name_prefix}-vnet-secondary"
  location            = var.secondary_location
  resource_group_name = azurerm_resource_group.secondary.name
  address_space       = [var.address_space.secondary]
  tags                = local.tags
}

resource "azurerm_subnet" "class" {
  for_each             = local.subnets
  name                 = "${var.name_prefix}-snet-${each.key}"
  resource_group_name  = each.value.vnet == "primary" ? azurerm_resource_group.primary.name : azurerm_resource_group.secondary.name
  virtual_network_name = each.value.vnet == "primary" ? azurerm_virtual_network.primary.name : azurerm_virtual_network.secondary.name
  address_prefixes     = [each.value.prefix]
  # No implicit outbound access: a VM without an explicit public IP or NAT has no internet path at all (C-10).
  default_outbound_access_enabled = false
}

resource "azurerm_subnet" "endpoints" {
  name                              = "${var.name_prefix}-snet-endpoints"
  resource_group_name               = azurerm_resource_group.primary.name
  virtual_network_name              = azurerm_virtual_network.primary.name
  address_prefixes                  = [local.endpoints_prefix]
  default_outbound_access_enabled   = false
  private_endpoint_network_policies = "Enabled" # NSG applies to the private endpoints too
}

# Global peering: mon-c scrapes and probes the primary network over private addresses, and holds an etcd member.
# The probe subnet is excluded from all of it by its NSG (deny VirtualNetwork both ways).
resource "azurerm_virtual_network_peering" "primary_to_secondary" {
  name                      = "${var.name_prefix}-peer-p2s"
  resource_group_name       = azurerm_resource_group.primary.name
  virtual_network_name      = azurerm_virtual_network.primary.name
  remote_virtual_network_id = azurerm_virtual_network.secondary.id
  allow_forwarded_traffic   = false
}

resource "azurerm_virtual_network_peering" "secondary_to_primary" {
  name                      = "${var.name_prefix}-peer-s2p"
  resource_group_name       = azurerm_resource_group.secondary.name
  virtual_network_name      = azurerm_virtual_network.secondary.name
  remote_virtual_network_id = azurerm_virtual_network.primary.id
  allow_forwarded_traffic   = false
}

resource "azurerm_network_security_group" "class" {
  for_each            = local.subnets
  name                = "${var.name_prefix}-nsg-${each.key}"
  location            = each.value.vnet == "primary" ? var.location : var.secondary_location
  resource_group_name = each.value.vnet == "primary" ? azurerm_resource_group.primary.name : azurerm_resource_group.secondary.name
  tags                = local.tags
}

resource "azurerm_network_security_rule" "allow" {
  for_each                     = { for r in local.rule_list : r.key => r }
  name                         = each.key
  resource_group_name          = azurerm_network_security_group.class[each.value.class].resource_group_name
  network_security_group_name  = azurerm_network_security_group.class[each.value.class].name
  priority                     = each.value.priority
  direction                    = each.value.direction
  access                       = "Allow"
  protocol                     = each.value.proto
  source_port_range            = "*"
  destination_port_ranges      = each.value.ports
  source_address_prefix        = length(each.value.src) == 1 ? each.value.src[0] : null
  source_address_prefixes      = length(each.value.src) == 1 ? null : each.value.src
  destination_address_prefix   = length(each.value.dst) == 1 ? each.value.dst[0] : null
  destination_address_prefixes = length(each.value.dst) == 1 ? null : each.value.dst
}

resource "azurerm_network_security_rule" "ssh" {
  for_each                    = toset(local.admin_rule_classes)
  name                        = "${each.key}-in-ssh-admin"
  resource_group_name         = azurerm_network_security_group.class[each.key].resource_group_name
  network_security_group_name = azurerm_network_security_group.class[each.key].name
  priority                    = 900
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "22"
  source_address_prefixes     = var.admin_source_cidrs
  destination_address_prefix  = local.subnets[each.key].prefix
}

# Explicit denials after the allow rules (Azure's defaults would allow all VNet traffic and internet egress).
resource "azurerm_network_security_rule" "deny_vnet_in" {
  for_each                    = local.subnets
  name                        = "${each.key}-in-deny-vnet"
  resource_group_name         = azurerm_network_security_group.class[each.key].resource_group_name
  network_security_group_name = azurerm_network_security_group.class[each.key].name
  priority                    = 4000
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "*"
}

resource "azurerm_network_security_rule" "deny_vnet_out" {
  for_each                    = local.subnets
  name                        = "${each.key}-out-deny-vnet"
  resource_group_name         = azurerm_network_security_group.class[each.key].resource_group_name
  network_security_group_name = azurerm_network_security_group.class[each.key].name
  priority                    = 4000
  direction                   = "Outbound"
  access                      = "Deny"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = "*"
  destination_address_prefix  = "VirtualNetwork"
}

resource "azurerm_network_security_rule" "deny_internet_out" {
  for_each                    = local.subnets
  name                        = "${each.key}-out-deny-internet"
  resource_group_name         = azurerm_network_security_group.class[each.key].resource_group_name
  network_security_group_name = azurerm_network_security_group.class[each.key].name
  priority                    = 4010
  direction                   = "Outbound"
  access                      = "Deny"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = "*"
  destination_address_prefix  = "Internet"
}

resource "azurerm_subnet_network_security_group_association" "class" {
  for_each                  = local.subnets
  subnet_id                 = azurerm_subnet.class[each.key].id
  network_security_group_id = azurerm_network_security_group.class[each.key].id
}

# Private endpoints of the backup accounts: their subnet accepts 443 from database-capable classes and the drill
# host only.
resource "azurerm_network_security_group" "endpoints" {
  name                = "${var.name_prefix}-nsg-endpoints"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

resource "azurerm_network_security_rule" "endpoints_in" {
  name                        = "endpoints-in-backup"
  resource_group_name         = azurerm_resource_group.primary.name
  network_security_group_name = azurerm_network_security_group.endpoints.name
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "443"
  source_address_prefixes     = [local.p.core.prefix, local.p.db.prefix, local.p.mon.prefix]
  destination_address_prefix  = local.endpoints_prefix
}

resource "azurerm_network_security_rule" "endpoints_deny" {
  name                        = "endpoints-in-deny"
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
