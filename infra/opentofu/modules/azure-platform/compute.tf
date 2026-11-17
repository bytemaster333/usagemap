# SPDX-License-Identifier: Apache-2.0
# Hosts: one Debian 13 VM per node (Docker Compose runs the services, ADR-0019), SSH keys only, Trusted Launch,
# a system-assigned identity (backup access for PostgreSQL nodes, read-only repository 2 for the drill host), and a
# data disk where requested (C-109). Public addresses only where a class serves or reaches the internet.

locals {
  public_ip_classes = ["edge", "core", "mon", "egress", "probe"]
  public_nodes      = { for n, v in var.nodes : n => v if contains(local.public_ip_classes, v.class) }
  disk_nodes        = { for n, v in var.nodes : n => v if v.data_disk_gb > 0 }
}

resource "azurerm_public_ip" "node" {
  for_each            = local.public_nodes
  name                = "${var.name_prefix}-pip-${each.key}"
  location            = local.node_location[each.key]
  resource_group_name = local.node_rg[each.key]
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = each.value.zone == null ? null : [each.value.zone]
  ip_version          = "IPv4"
  tags                = merge(local.tags, { node = each.key, class = each.value.class })
}

resource "azurerm_network_interface" "node" {
  for_each            = var.nodes
  name                = "${var.name_prefix}-nic-${each.key}"
  location            = local.node_location[each.key]
  resource_group_name = local.node_rg[each.key]
  tags                = merge(local.tags, { node = each.key, class = each.value.class })

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.class[each.value.class].id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = contains(local.public_ip_classes, each.value.class) ? azurerm_public_ip.node[each.key].id : null
  }
}

resource "azurerm_linux_virtual_machine" "node" {
  for_each                        = var.nodes
  name                            = "${var.name_prefix}-${each.key}"
  computer_name                   = each.key
  location                        = local.node_location[each.key]
  resource_group_name             = local.node_rg[each.key]
  size                            = each.value.size
  zone                            = each.value.zone
  admin_username                  = "scfadmin"
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.node[each.key].id]
  encryption_at_host_enabled      = var.encryption_at_host
  secure_boot_enabled             = true
  vtpm_enabled                    = true
  patch_mode                      = "ImageDefault" # unattended-upgrades, staggered by Ansible (ADR-0019)
  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
    node_name = each.key
    class     = each.value.class
  }))
  tags = merge(local.tags, { node = each.key, class = each.value.class })

  dynamic "admin_ssh_key" {
    for_each = var.admin_ssh_keys
    content {
      username   = "scfadmin"
      public_key = admin_ssh_key.value
    }
  }

  identity {
    type = "SystemAssigned"
  }

  os_disk {
    name                 = "${var.name_prefix}-osdisk-${each.key}"
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 64
  }

  source_image_reference {
    publisher = var.image.publisher
    offer     = var.image.offer
    sku       = var.image.sku
    version   = var.image.version
  }

  boot_diagnostics {} # managed storage; serial console for break-glass
}

resource "azurerm_managed_disk" "data" {
  for_each             = local.disk_nodes
  name                 = "${var.name_prefix}-datadisk-${each.key}"
  location             = local.node_location[each.key]
  resource_group_name  = local.node_rg[each.key]
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = each.value.data_disk_gb
  zone                 = each.value.zone
  tags                 = merge(local.tags, { node = each.key, class = each.value.class })
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  for_each           = local.disk_nodes
  managed_disk_id    = azurerm_managed_disk.data[each.key].id
  virtual_machine_id = azurerm_linux_virtual_machine.node[each.key].id
  lun                = 0
  caching            = "ReadOnly"
}
