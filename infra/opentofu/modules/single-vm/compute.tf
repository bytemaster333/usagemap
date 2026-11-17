# SPDX-License-Identifier: Apache-2.0
# The VM with two front addresses (ingest and portal: 1:1 NAT keeps the client address the gateway's anti-inflation
# rules need) and the optional temporary drill VMs (outbound-only public IP, SSH from the operators only).

resource "azurerm_public_ip" "front" {
  for_each            = toset(["ingest", "portal"])
  name                = "${var.name_prefix}-pip-${each.key}"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
  ip_version          = "IPv4"
  tags                = merge(local.tags, { front = each.key })
}

resource "azurerm_network_interface" "app" {
  name                = "${var.name_prefix}-nic-${var.vm.name}"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg.name
  tags                = local.tags

  ip_configuration {
    name                          = "ingest"
    primary                       = true
    subnet_id                     = azurerm_subnet.app.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.ip_ingest
    public_ip_address_id          = azurerm_public_ip.front["ingest"].id
  }

  ip_configuration {
    name                          = "portal"
    subnet_id                     = azurerm_subnet.app.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.ip_portal
    public_ip_address_id          = azurerm_public_ip.front["portal"].id
  }
}

locals {
  cloud_init = { for n in concat([var.vm.name], keys(var.drill_vms)) : n => base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
    node_name = n
    role      = n == var.vm.name ? "app" : "drill"
  })) }
}

resource "azurerm_linux_virtual_machine" "app" {
  name                            = var.vm.name
  computer_name                   = var.vm.name
  location                        = var.location
  resource_group_name             = data.azurerm_resource_group.rg.name
  size                            = var.vm.size
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.app.id]
  encryption_at_host_enabled      = var.encryption_at_host
  secure_boot_enabled             = true
  vtpm_enabled                    = true
  patch_mode                      = "ImageDefault" # unattended security upgrades, configured by Ansible
  # No VM extensions: Run Command and extensions are root on the VM (threat model); Ansible over SSH configures it.
  allow_extension_operations = false
  custom_data                = local.cloud_init[var.vm.name]
  tags                       = merge(local.tags, { node = var.vm.name, role = "app" })

  dynamic "admin_ssh_key" {
    for_each = var.admin_ssh_keys
    content {
      username   = var.admin_username
      public_key = admin_ssh_key.value
    }
  }

  os_disk {
    name                 = "${var.name_prefix}-osdisk-${var.vm.name}"
    caching              = "ReadWrite"
    storage_account_type = var.vm.os_disk_type
    disk_size_gb         = var.vm.os_disk_gb
  }

  source_image_reference {
    publisher = var.image.publisher
    offer     = var.image.offer
    sku       = var.image.sku
    version   = var.image.version
  }

  boot_diagnostics {} # managed storage; serial console stays available for break-glass

  lifecycle {
    ignore_changes = [custom_data] # first boot only
  }
}

# ---------------------------------------------------------------- temporary drill VMs

resource "azurerm_public_ip" "drill" {
  for_each            = var.drill_vms
  name                = "${var.name_prefix}-pip-${each.key}"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
  ip_version          = "IPv4"
  tags                = merge(local.tags, { purpose = "drill" })
}

resource "azurerm_network_interface" "drill" {
  for_each            = var.drill_vms
  name                = "${var.name_prefix}-nic-${each.key}"
  location            = var.location
  resource_group_name = data.azurerm_resource_group.rg.name
  tags                = merge(local.tags, { purpose = "drill" })

  ip_configuration {
    name                          = "primary"
    primary                       = true
    subnet_id                     = azurerm_subnet.app.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.drill_ips[each.key]
    public_ip_address_id          = azurerm_public_ip.drill[each.key].id
  }
}

resource "azurerm_linux_virtual_machine" "drill" {
  for_each                        = var.drill_vms
  name                            = each.key
  computer_name                   = each.key
  location                        = var.location
  resource_group_name             = data.azurerm_resource_group.rg.name
  size                            = each.value
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.drill[each.key].id]
  encryption_at_host_enabled      = var.encryption_at_host
  secure_boot_enabled             = true
  vtpm_enabled                    = true
  allow_extension_operations      = false
  custom_data                     = local.cloud_init[each.key]
  tags                            = merge(local.tags, { node = each.key, role = "drill", purpose = "drill" })

  dynamic "admin_ssh_key" {
    for_each = var.admin_ssh_keys
    content {
      username   = var.admin_username
      public_key = admin_ssh_key.value
    }
  }

  os_disk {
    name                 = "${var.name_prefix}-osdisk-${each.key}"
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 64
  }

  source_image_reference {
    publisher = var.image.publisher
    offer     = var.image.offer
    sku       = var.image.sku
    version   = var.image.version
  }

  boot_diagnostics {}
}
