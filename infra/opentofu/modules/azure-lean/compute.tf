# SPDX-License-Identifier: Apache-2.0
# The application VM (two front-end addresses: ingest and portal) and the optional standby VM. Debian 13 pinned to one
# image version, Trusted Launch, SSH keys only, encryption at host, a system-assigned identity (backups, ACME DNS-01),
# a ≥ 250 GB data disk for Docker's data root (PostgreSQL and every volume, C-109).

resource "azurerm_public_ip" "front" {
  for_each            = toset(["ingest", "portal"])
  name                = "${var.name_prefix}-pip-${each.key}"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = [var.app_vm.zone]
  ip_version          = "IPv4"
  tags                = merge(local.tags, { front = each.key })
}

# The standby VM's address is for outbound only (OS updates, image pulls); the NSG admits nothing but SSH.
resource "azurerm_public_ip" "standby" {
  count               = var.enable_standby ? 1 : 0
  name                = "${var.name_prefix}-pip-standby"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = [var.standby_vm.zone]
  ip_version          = "IPv4"
  tags                = local.tags
}

resource "azurerm_network_interface" "app" {
  name                = "${var.name_prefix}-nic-${var.app_vm.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
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

resource "azurerm_network_interface" "standby" {
  count               = var.enable_standby ? 1 : 0
  name                = "${var.name_prefix}-nic-${var.standby_vm.name}"
  location            = var.location
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags

  ip_configuration {
    name                          = "primary"
    primary                       = true
    subnet_id                     = azurerm_subnet.app.id
    private_ip_address_allocation = "Static"
    private_ip_address            = local.ip_standby
    public_ip_address_id          = azurerm_public_ip.standby[0].id
  }
}

locals {
  nic_ids = merge(
    { app = azurerm_network_interface.app.id },
    var.enable_standby ? { standby = azurerm_network_interface.standby[0].id } : {},
  )
}

resource "azurerm_linux_virtual_machine" "vm" {
  for_each                        = local.vms
  name                            = "${var.name_prefix}-${each.value.name}"
  computer_name                   = each.value.name
  location                        = var.location
  resource_group_name             = azurerm_resource_group.primary.name
  size                            = each.value.size
  zone                            = each.value.zone
  admin_username                  = "scfadmin"
  disable_password_authentication = true
  network_interface_ids           = [local.nic_ids[each.key]]
  encryption_at_host_enabled      = var.encryption_at_host
  secure_boot_enabled             = true
  vtpm_enabled                    = true
  patch_mode                      = "ImageDefault" # unattended security upgrades, configured by Ansible (ADR-0019)
  # No VM extensions: Run Command and extensions are root on the VM (threat model); Ansible over SSH configures it.
  allow_extension_operations = false
  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
    node_name = each.value.name
    role      = each.key
  }))
  tags = merge(local.tags, { node = each.value.name, role = each.key })

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
    name                 = "${var.name_prefix}-osdisk-${each.value.name}"
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

  boot_diagnostics {} # managed storage; serial console stays available for break-glass (threat model)
}

resource "azurerm_managed_disk" "data" {
  for_each             = local.vms
  name                 = "${var.name_prefix}-datadisk-${each.value.name}"
  location             = var.location
  resource_group_name  = azurerm_resource_group.primary.name
  storage_account_type = "Premium_LRS"
  create_option        = "Empty"
  disk_size_gb         = each.value.disk_gb
  zone                 = each.value.zone
  # Disk exports (SAS download URLs) are a data-exfiltration path: off; snapshots stay possible for operators.
  public_network_access_enabled = false
  network_access_policy         = "DenyAll"
  tags                          = merge(local.tags, { node = each.value.name })
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  for_each           = local.vms
  managed_disk_id    = azurerm_managed_disk.data[each.key].id
  virtual_machine_id = azurerm_linux_virtual_machine.vm[each.key].id
  lun                = 0
  caching            = "ReadOnly"
}
