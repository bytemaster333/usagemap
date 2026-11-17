# SPDX-License-Identifier: Apache-2.0
# TFLint (MPL-2.0) with the Azure ruleset (MPL-2.0), both pinned. Run: infra/opentofu/scripts/check.sh
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "azurerm" {
  enabled = true
  version = "0.33.0"
  source  = "github.com/terraform-linters/tflint-ruleset-azurerm"
}
